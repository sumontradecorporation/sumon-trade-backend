import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { ctxOf } from '../../core/ctx.js';
import { AppError } from '../../core/errors.js';
import { created, escapeRegex, ok, oid, pageMeta, pageQuery, round2, searchRegex, str } from '../../core/http.js';
import { TXN_CONFIG, type TxnType } from '../../core/txn.js';
import { money, objectId, optDate, optStr, optionalId } from '../../core/zod.js';
import { requirePermission } from '../../middleware/company.js';
import { memoryUpload } from '../../middleware/upload.js';
import { validate } from '../../middleware/validate.js';
import { Category, Item, StockAdjustment, Transaction, Unit, UnitConversion } from '../../models/index.js';
import { needsApproval, queueForApproval, registerApprovalHandler } from '../../services/approvals.js';
import { audit } from '../../services/audit.js';
import { parseSheet, templateXlsx, toXlsx } from '../../services/excel.js';
import { recalcItems } from '../../services/ledger.js';
import { nextSeq } from '../../services/numbering.js';
import type { Ctx } from '../../core/ctx.js';

const router = Router();

export const itemSchema = z
  .object({
    type: z.enum(['product', 'service']).default('product'),
    name: z.string().trim().min(1, 'Item name is required').max(200),
    code: optStr,
    hsn: optStr,
    category: optionalId,
    baseUnit: optionalId,
    secondaryUnit: optionalId,
    conversionRate: z.coerce.number().positive().default(1),
    salePrice: money,
    saleTaxInclusive: z.boolean().default(false),
    wholesalePrice: money,
    minWholesaleQty: money,
    purchasePrice: money,
    purchaseTaxInclusive: z.boolean().default(false),
    mrp: z.coerce.number().min(0).optional().nullable().transform((v) => v ?? undefined),
    taxRate: z.coerce.number().min(0).max(100).default(0),
    openingQty: z.coerce.number().default(0),
    openingPrice: money,
    openingDate: optDate,
    minStock: money,
    location: optStr,
    description: optStr,
    images: z.array(objectId).max(10).default([]),
    isActive: z.boolean().default(true),
  })
  .refine((v) => !v.secondaryUnit || v.secondaryUnit !== v.baseUnit, { message: 'Secondary unit must differ from base unit', path: ['secondaryUnit'] });
type ItemBody = z.infer<typeof itemSchema>;

async function assertRefs(companyId: Types.ObjectId, b: Partial<ItemBody>) {
  if (b.category && !(await Category.exists({ _id: b.category, company: companyId }))) throw AppError.badRequest('Category not found');
  for (const u of [b.baseUnit, b.secondaryUnit]) if (u && !(await Unit.exists({ _id: u, company: companyId }))) throw AppError.badRequest('Unit not found');
}

async function assertUniqueName(companyId: Types.ObjectId, name: string, exceptId?: unknown) {
  const exists = await Item.exists({ company: companyId, name: new RegExp(`^${escapeRegex(name)}$`, 'i'), ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
  if (exists) throw AppError.conflict(`An item named "${name}" already exists`);
}

async function generateCode(companyId: Types.ObjectId) {
  for (;;) {
    const code = `ITM${String(await nextSeq(companyId, 'ITEM_CODE')).padStart(5, '0')}`;
    if (!(await Item.exists({ company: companyId, code }))) return code;
  }
}

/* ---------------- Categories ---------------- */

router.get('/categories', requirePermission('items.view'), async (req, res) => {
  const ctx = ctxOf(req);
  const [cats, stats] = await Promise.all([
    Category.find({ company: ctx.companyId }).sort({ name: 1 }).lean(),
    Item.aggregate([
      { $match: { company: ctx.companyId } },
      { $group: { _id: '$category', items: { $sum: 1 }, stock: { $sum: '$stock' }, value: { $sum: { $multiply: [{ $max: ['$stock', 0] }, '$purchasePrice'] } } } },
    ]),
  ]);
  const m = new Map(stats.map((s) => [String(s._id), s]));
  const un = m.get('null');
  ok(res, {
    categories: cats.map((c) => ({ ...c, items: m.get(String(c._id))?.items ?? 0, stockValue: round2(m.get(String(c._id))?.value ?? 0) })),
    uncategorised: { items: un?.items ?? 0, stockValue: round2(un?.value ?? 0) },
  });
});

const nameSchema = z.object({ name: z.string().trim().min(1).max(80) });

router.post('/categories', requirePermission('items.create'), validate(nameSchema), async (req, res) => {
  const ctx = ctxOf(req);
  const c = await Category.create({ company: ctx.companyId, name: req.body.name });
  await audit(ctx, 'create', 'Category', c._id, `Category ${c.name} created`);
  created(res, c.toObject());
});

router.put('/categories/:id', requirePermission('items.edit'), validate(nameSchema), async (req, res) => {
  const ctx = ctxOf(req);
  const c = await Category.findOneAndUpdate({ _id: oid(req.params.id), company: ctx.companyId }, { $set: { name: req.body.name } }, { returnDocument: 'after' }).lean();
  if (!c) throw AppError.notFound('Category');
  await audit(ctx, 'update', 'Category', c._id, `Category renamed to ${c.name}`);
  ok(res, c);
});

async function deleteCategory(ctx: Ctx, id: Types.ObjectId | string) {
  const c = await Category.findOneAndDelete({ _id: id, company: ctx.companyId }).lean();
  if (!c) throw AppError.notFound('Category');
  await Item.updateMany({ company: ctx.companyId, category: c._id }, { $unset: { category: 1 } });
  await audit(ctx, 'delete', 'Category', c._id, `Category ${c.name} deleted`);
}

registerApprovalHandler('category_delete', { approve: (ctx, a) => deleteCategory(ctx, a.entityId!) });

router.delete('/categories/:id', requirePermission('items.delete'), async (req, res) => {
  const ctx = ctxOf(req);
  const c = await Category.findOne({ _id: oid(req.params.id), company: ctx.companyId }).lean();
  if (!c) throw AppError.notFound('Category');
  if (needsApproval(ctx, 'items.delete')) {
    const items = await Item.countDocuments({ company: ctx.companyId, category: c._id });
    return queueForApproval(res, ctx, { kind: 'category_delete', entity: 'Category', entityId: c._id, label: `Delete item category ${c.name}`, before: { ...c, items } });
  }
  await deleteCategory(ctx, c._id);
  ok(res, { deleted: true });
});

router.post('/categories/:id/assign', requirePermission('items.edit'), validate(z.object({ items: z.array(objectId).min(1) })), async (req, res) => {
  const ctx = ctxOf(req);
  const cat = await Category.findOne({ _id: oid(req.params.id), company: ctx.companyId }).lean();
  if (!cat) throw AppError.notFound('Category');
  const r = await Item.updateMany({ company: ctx.companyId, _id: { $in: req.body.items } }, { $set: { category: cat._id } });
  ok(res, { moved: r.modifiedCount });
});

/* ---------------- Units & conversions ---------------- */

router.get('/units', requirePermission('items.view'), async (req, res) => {
  const ctx = ctxOf(req);
  const [units, conversions] = await Promise.all([
    Unit.find({ company: ctx.companyId }).sort({ name: 1 }).lean(),
    UnitConversion.find({ company: ctx.companyId }).populate('baseUnit secondaryUnit', 'name shortName').lean(),
  ]);
  ok(res, { units, conversions });
});

const unitSchema = z.object({ name: z.string().trim().min(1).max(40), shortName: z.string().trim().min(1).max(10).transform((s) => s.toUpperCase()) });

router.post('/units', requirePermission('items.create'), validate(unitSchema), async (req, res) => {
  const ctx = ctxOf(req);
  const u = await Unit.create({ company: ctx.companyId, ...req.body });
  await audit(ctx, 'create', 'Unit', u._id, `Unit ${u.name} created`);
  created(res, u.toObject());
});

router.put('/units/:id', requirePermission('items.edit'), validate(unitSchema), async (req, res) => {
  const ctx = ctxOf(req);
  const u = await Unit.findOneAndUpdate({ _id: oid(req.params.id), company: ctx.companyId }, { $set: req.body }, { returnDocument: 'after' }).lean();
  if (!u) throw AppError.notFound('Unit');
  ok(res, u);
});

async function assertUnitUnused(ctx: Ctx, id: Types.ObjectId) {
  const used = await Item.countDocuments({ company: ctx.companyId, $or: [{ baseUnit: id }, { secondaryUnit: id }] });
  if (used) throw AppError.badRequest(`This unit is used by ${used} item(s)`);
}

async function deleteUnit(ctx: Ctx, id: Types.ObjectId) {
  await assertUnitUnused(ctx, id);
  const u = await Unit.findOneAndDelete({ _id: id, company: ctx.companyId }).lean();
  if (!u) throw AppError.notFound('Unit');
  await UnitConversion.deleteMany({ company: ctx.companyId, $or: [{ baseUnit: id }, { secondaryUnit: id }] });
  await audit(ctx, 'delete', 'Unit', id, `Unit ${u.name} deleted`);
}

registerApprovalHandler('unit_delete', { approve: (ctx, a) => deleteUnit(ctx, a.entityId!) });

router.delete('/units/:id', requirePermission('items.delete'), async (req, res) => {
  const ctx = ctxOf(req);
  const u = await Unit.findOne({ _id: oid(req.params.id), company: ctx.companyId }).lean();
  if (!u) throw AppError.notFound('Unit');
  if (needsApproval(ctx, 'items.delete')) {
    await assertUnitUnused(ctx, u._id);
    return queueForApproval(res, ctx, { kind: 'unit_delete', entity: 'Unit', entityId: u._id, label: `Delete unit ${u.name} (${u.shortName})`, before: u });
  }
  await deleteUnit(ctx, u._id);
  ok(res, { deleted: true });
});

const conversionSchema = z
  .object({ baseUnit: objectId, secondaryUnit: objectId, rate: z.coerce.number().positive('Rate must be greater than 0') })
  .refine((v) => v.baseUnit !== v.secondaryUnit, { message: 'Choose two different units', path: ['secondaryUnit'] });

router.post('/unit-conversions', requirePermission('items.create'), validate(conversionSchema), async (req, res) => {
  const ctx = ctxOf(req);
  await assertRefs(ctx.companyId, { baseUnit: req.body.baseUnit, secondaryUnit: req.body.secondaryUnit });
  const c = await UnitConversion.findOneAndUpdate(
    { company: ctx.companyId, baseUnit: req.body.baseUnit, secondaryUnit: req.body.secondaryUnit },
    { $set: { rate: req.body.rate } },
    { upsert: true, returnDocument: 'after' },
  ).populate('baseUnit secondaryUnit', 'name shortName');
  await audit(ctx, 'create', 'UnitConversion', c!._id, `Unit conversion saved`);
  created(res, c!.toObject());
});

async function deleteConversion(ctx: Ctx, id: Types.ObjectId | string) {
  const c = await UnitConversion.findOneAndDelete({ _id: id, company: ctx.companyId }).lean();
  if (!c) throw AppError.notFound('Conversion');
  await audit(ctx, 'delete', 'UnitConversion', c._id, 'Unit conversion deleted');
}

registerApprovalHandler('unit_conversion_delete', { approve: (ctx, a) => deleteConversion(ctx, a.entityId!) });

router.delete('/unit-conversions/:id', requirePermission('items.delete'), async (req, res) => {
  const ctx = ctxOf(req);
  const c = await UnitConversion.findOne({ _id: oid(req.params.id), company: ctx.companyId })
    .populate<{ baseUnit: { shortName: string } | null; secondaryUnit: { shortName: string } | null }>('baseUnit secondaryUnit', 'shortName')
    .lean();
  if (!c) throw AppError.notFound('Conversion');
  if (needsApproval(ctx, 'items.delete')) {
    const label = `Delete unit conversion 1 ${c.baseUnit?.shortName ?? '?'} = ${c.rate} ${c.secondaryUnit?.shortName ?? '?'}`;
    return queueForApproval(res, ctx, { kind: 'unit_conversion_delete', entity: 'UnitConversion', entityId: c._id, label, before: c });
  }
  await deleteConversion(ctx, c._id);
  ok(res, { deleted: true });
});

/* ---------------- Bulk import / export ---------------- */

const IMPORT_HEADERS = ['Item Name*', 'Item Code', 'HS Code', 'Category', 'Base Unit', 'Secondary Unit', 'Conversion Rate', 'Sale Price', 'Wholesale Price', 'Min Wholesale Qty', 'Purchase Price', 'Tax Rate', 'Opening Qty', 'Opening Price', 'Min Stock', 'Location', 'Type'];

router.get('/import/template', requirePermission('items.import'), async (_req, res) => {
  const buf = await templateXlsx('Items', IMPORT_HEADERS, [
    ['Miniket Rice 5kg', '', '1006', 'Grocery', 'BAG', 'KG', 5, 650, 620, 10, 540, 5, 40, 540, 5, 'Rack A1', 'product'],
    ['Installation Charge', '', '9987', 'Services', 'NOS', '', '', 500, '', '', '', 15, '', '', '', '', 'service'],
  ], ['Item Code', 'HS Code']);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="items-import-template.xlsx"');
  res.send(buf);
});

const num = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

router.post('/import/parse', requirePermission('items.import'), memoryUpload.single('file'), async (req, res) => {
  const ctx = ctxOf(req);
  if (!req.file) throw AppError.badRequest('Upload an .xlsx or .csv file');
  const raw = await parseSheet(req.file.buffer, req.file.originalname);
  const existing = new Set((await Item.find({ company: ctx.companyId }).select('name').lean()).map((i) => i.name.toLowerCase()));
  const seen = new Set<string>();
  const rows = raw.slice(0, 5000).map((r, i) => {
    const name = (r['Item Name*'] ?? r['Item Name'] ?? r['Name'] ?? '').trim();
    const errors: string[] = [];
    if (!name) errors.push('Name is required');
    if (name && existing.has(name.toLowerCase())) errors.push('Already exists');
    if (name && seen.has(name.toLowerCase())) errors.push('Duplicate in file');
    seen.add(name.toLowerCase());
    return {
      row: i + 2,
      name,
      code: r['Item Code'] || undefined,
      hsn: r['HS Code'] || undefined,
      category: r['Category'] || undefined,
      baseUnit: r['Base Unit'] || undefined,
      secondaryUnit: r['Secondary Unit'] || undefined,
      conversionRate: num(r['Conversion Rate']) || 1,
      salePrice: num(r['Sale Price']),
      wholesalePrice: num(r['Wholesale Price']),
      minWholesaleQty: num(r['Min Wholesale Qty']),
      purchasePrice: num(r['Purchase Price']),
      taxRate: num(r['Tax Rate']),
      openingQty: num(r['Opening Qty']),
      openingPrice: num(r['Opening Price']),
      minStock: num(r['Min Stock']),
      location: r['Location'] || undefined,
      type: /service/i.test(r['Type'] ?? '') ? 'service' : 'product',
      errors,
    };
  });
  ok(res, { rows, valid: rows.filter((r) => !r.errors.length).length, invalid: rows.filter((r) => r.errors.length).length });
});

const bulkRowSchema = z.object({
  name: z.string().trim().min(1),
  code: optStr,
  hsn: optStr,
  category: optStr,
  baseUnit: optStr,
  secondaryUnit: optStr,
  conversionRate: z.coerce.number().positive().default(1),
  salePrice: money,
  wholesalePrice: money,
  minWholesaleQty: money,
  purchasePrice: money,
  taxRate: z.coerce.number().min(0).max(100).default(0),
  openingQty: z.coerce.number().default(0),
  openingPrice: money,
  minStock: money,
  location: optStr,
  type: z.enum(['product', 'service']).default('product'),
});

router.post('/bulk', requirePermission('items.import'), validate(z.object({ items: z.array(bulkRowSchema).min(1).max(5000) })), async (req, res) => {
  const ctx = ctxOf(req);
  const rows = req.body.items as z.infer<typeof bulkRowSchema>[];
  const catCache = new Map<string, Types.ObjectId>();
  const unitCache = new Map<string, Types.ObjectId>();
  for (const c of await Category.find({ company: ctx.companyId }).lean()) catCache.set(c.name.toLowerCase(), c._id);
  for (const u of await Unit.find({ company: ctx.companyId }).lean()) {
    unitCache.set(u.shortName.toLowerCase(), u._id);
    unitCache.set(u.name.toLowerCase(), u._id);
  }
  const catId = async (name?: string) => {
    if (!name) return undefined;
    const k = name.toLowerCase();
    if (!catCache.has(k)) catCache.set(k, (await Category.create({ company: ctx.companyId, name }))._id);
    return catCache.get(k);
  };
  const unitId = async (name?: string) => {
    if (!name) return undefined;
    const k = name.toLowerCase();
    if (!unitCache.has(k)) unitCache.set(k, (await Unit.create({ company: ctx.companyId, name, shortName: name.toUpperCase().slice(0, 10) }))._id);
    return unitCache.get(k);
  };
  const existing = new Set((await Item.find({ company: ctx.companyId }).select('name').lean()).map((i) => i.name.toLowerCase()));
  const createdIds: Types.ObjectId[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const r of rows) {
    if (existing.has(r.name.toLowerCase())) {
      skipped.push({ name: r.name, reason: 'Already exists' });
      continue;
    }
    try {
      const it = await Item.create({
        ...r,
        company: ctx.companyId,
        code: r.code || (ctx.settings.items.enableItemCode ? await generateCode(ctx.companyId) : undefined),
        category: await catId(r.category),
        baseUnit: await unitId(r.baseUnit),
        secondaryUnit: await unitId(r.secondaryUnit),
        createdBy: ctx.userId,
      });
      existing.add(r.name.toLowerCase());
      createdIds.push(it._id);
    } catch (err) {
      skipped.push({ name: r.name, reason: err instanceof Error ? err.message : 'Failed' });
    }
  }
  await recalcItems(ctx.companyId, createdIds);
  await audit(ctx, 'import', 'Item', undefined, `${createdIds.length} item${createdIds.length === 1 ? '' : 's'} imported${skipped.length ? `, ${skipped.length} skipped` : ''}`);
  ok(res, { created: createdIds.length, skipped });
});

/** Fields the bulk editor may change; anything left out of a row stays as it is. */
const bulkUpdateRow = z.object({
  id: objectId,
  salePrice: z.coerce.number().finite().min(0).optional(),
  purchasePrice: z.coerce.number().finite().min(0).optional(),
  wholesalePrice: z.coerce.number().finite().min(0).optional(),
  minWholesaleQty: z.coerce.number().finite().min(0).optional(),
  mrp: z.coerce.number().finite().min(0).nullable().optional(),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  minStock: z.coerce.number().finite().min(0).optional(),
  hsn: z.string().trim().max(20).optional(),
  location: z.string().trim().max(100).optional(),
  category: z.union([objectId, z.literal(''), z.null()]).optional(),
});

router.put('/bulk-update', requirePermission('items.edit'), validate(z.object({ items: z.array(bulkUpdateRow).min(1).max(5000) })), async (req, res) => {
  const ctx = ctxOf(req);
  const rows = req.body.items as z.infer<typeof bulkUpdateRow>[];
  const categories = new Set((await Category.find({ company: ctx.companyId }).select('_id').lean()).map((c) => String(c._id)));
  const items = new Map((await Item.find({ company: ctx.companyId, _id: { $in: rows.map((r) => r.id) } })).map((i) => [String(i._id), i]));
  let updated = 0;
  const skipped: { id: string; reason: string }[] = [];
  for (const { id, category, mrp, ...fields } of rows) {
    const item = items.get(id);
    if (!item) {
      skipped.push({ id, reason: 'Item not found' });
      continue;
    }
    if (category && !categories.has(category)) {
      skipped.push({ id, reason: `${item.name}: category not found` });
      continue;
    }
    const before = item.toObject();
    item.set(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
    if (category !== undefined) item.set('category', category || undefined);
    if (mrp !== undefined) item.set('mrp', mrp ?? undefined);
    if (!item.isModified()) continue;
    const changed = item.modifiedPaths();
    await item.save();
    updated += 1;
    await audit(ctx, 'update', 'Item', item._id, `Item ${item.name} updated in bulk (${changed.join(', ')})`, before, item.toObject());
  }
  ok(res, { updated, skipped });
});

router.get('/export', requirePermission('items.view'), async (req, res) => {
  const ctx = ctxOf(req);
  const items = await Item.find({ company: ctx.companyId }).populate('category', 'name').populate('baseUnit secondaryUnit', 'shortName').sort({ name: 1 }).lean();
  const rows = items.map((i) => {
    const r = i as unknown as Record<string, { name?: string; shortName?: string } | undefined>;
    return {
      name: i.name, code: i.code, hsn: i.hsn, category: r.category?.name, baseUnit: r.baseUnit?.shortName, secondaryUnit: r.secondaryUnit?.shortName,
      conversionRate: i.conversionRate, salePrice: i.salePrice, wholesalePrice: i.wholesalePrice, purchasePrice: i.purchasePrice, taxRate: i.taxRate,
      stock: i.stock, stockValue: round2(Math.max(0, i.stock) * i.purchasePrice), minStock: i.minStock, location: i.location, type: i.type,
    };
  });
  const buf = await toXlsx({
    title: 'Items',
    subtitle: `${ctx.companyName} — exported ${new Date().toLocaleString('en-IN')}`,
    columns: [
      { key: 'name', label: 'Item Name', width: 30 }, { key: 'code', label: 'Code' }, { key: 'hsn', label: 'HS Code' }, { key: 'category', label: 'Category' },
      { key: 'baseUnit', label: 'Base Unit' }, { key: 'secondaryUnit', label: 'Secondary Unit' }, { key: 'conversionRate', label: 'Conversion', type: 'number' },
      { key: 'salePrice', label: 'Sale Price', type: 'money' }, { key: 'wholesalePrice', label: 'Wholesale', type: 'money' }, { key: 'purchasePrice', label: 'Purchase Price', type: 'money' },
      { key: 'taxRate', label: 'Tax %', type: 'percent' }, { key: 'stock', label: 'Stock', type: 'number' }, { key: 'stockValue', label: 'Stock Value', type: 'money' },
      { key: 'minStock', label: 'Min Stock', type: 'number' }, { key: 'location', label: 'Location' }, { key: 'type', label: 'Type' },
    ],
    rows,
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="items.xlsx"');
  res.send(buf);
});

/* ---------------- Items ---------------- */

router.get('/next-code', requirePermission('items.create', 'items.edit'), async (req, res) => {
  ok(res, { code: await generateCode(ctxOf(req).companyId) });
});

/** Gives items without a code the next generated one (barcode labels need a code). */
router.post('/assign-codes', requirePermission('items.edit'), validate(z.object({ items: z.array(objectId).min(1).max(5000) })), async (req, res) => {
  const ctx = ctxOf(req);
  const items = await Item.find({ company: ctx.companyId, _id: { $in: req.body.items }, $or: [{ code: { $exists: false } }, { code: null }, { code: '' }] });
  const codes: Record<string, string> = {};
  for (const item of items) {
    item.code = await generateCode(ctx.companyId);
    await item.save();
    codes[String(item._id)] = item.code;
  }
  if (items.length) await audit(ctx, 'update', 'Item', undefined, `Item codes generated for ${items.length} item${items.length === 1 ? '' : 's'}`);
  ok(res, { codes });
});

router.get('/', requirePermission('items.view'), async (req, res) => {
  const ctx = ctxOf(req);
  const q = pageQuery(req, 1000, 5000);
  const filter: Record<string, unknown> = { company: ctx.companyId };
  const rx = searchRegex(req.query.search);
  if (rx) filter.$or = [{ name: rx }, { code: rx }, { hsn: rx }];
  const cat = str(req.query.category);
  if (cat === 'none') filter.category = { $exists: false };
  else if (cat) filter.category = oid(cat, 'category');
  if (str(req.query.type)) filter.type = req.query.type;
  if (req.query.active !== 'all') filter.isActive = { $ne: false };
  if (req.query.lowStock === 'true') filter.$expr = { $and: [{ $eq: ['$type', 'product'] }, { $lte: ['$stock', '$minStock'] }, { $gt: ['$minStock', 0] }] };
  const [rows, total, sums] = await Promise.all([
    Item.find(filter).sort({ name: 1 }).collation({ locale: 'en' }).skip(q.skip).limit(q.limit).populate('category', 'name').populate('baseUnit secondaryUnit', 'name shortName').lean(),
    Item.countDocuments(filter),
    Item.aggregate([
      { $match: { company: ctx.companyId, type: 'product' } },
      {
        $group: {
          _id: null,
          value: { $sum: { $multiply: [{ $max: ['$stock', 0] }, '$purchasePrice'] } },
          low: { $sum: { $cond: [{ $and: [{ $gt: ['$minStock', 0] }, { $lte: ['$stock', '$minStock'] }] }, 1, 0] } },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);
  ok(
    res,
    rows.map((r) => ({ ...r, stockValue: round2(Math.max(0, r.stock) * r.purchasePrice) })),
    { ...pageMeta(total, q), summary: { stockValue: round2(sums[0]?.value ?? 0), lowStock: sums[0]?.low ?? 0, products: sums[0]?.count ?? 0 } },
  );
});

router.get('/:id', requirePermission('items.view'), async (req, res) => {
  const ctx = ctxOf(req);
  const item = await Item.findOne({ _id: oid(req.params.id), company: ctx.companyId }).populate('category', 'name').populate('baseUnit secondaryUnit', 'name shortName').populate('images', 'originalName mime').lean();
  if (!item) throw AppError.notFound('Item');
  ok(res, { ...item, stockValue: round2(Math.max(0, item.stock) * item.purchasePrice) });
});

/** Item history: opening stock, every document line and manual adjustments. */
router.get('/:id/transactions', requirePermission('items.view'), async (req, res) => {
  const ctx = ctxOf(req);
  const item = await Item.findOne({ _id: oid(req.params.id), company: ctx.companyId }).populate<{ baseUnit: { shortName: string } | null }>('baseUnit', 'shortName').lean();
  if (!item) throw AppError.notFound('Item');
  const types = str(req.query.type)?.split(',');
  const [txns, adjustments] = await Promise.all([
    Transaction.aggregate([
      { $match: { company: ctx.companyId, 'items.item': item._id, ...(types ? { type: { $in: types } } : {}) } },
      { $unwind: '$items' },
      { $match: { 'items.item': item._id } },
      {
        $project: {
          kind: 'txn', type: 1, number: 1, party: 1, partyName: 1, phone: 1, date: 1, dueDate: 1, status: 1, balance: 1, total: 1,
          qty: '$items.qty', unitName: '$items.unitName', price: '$items.price', amount: '$items.amount', baseQty: '$items.baseQty',
        },
      },
      { $sort: { date: -1, _id: -1 } },
      { $limit: 2000 },
    ]),
    types ? Promise.resolve([]) : StockAdjustment.find({ company: ctx.companyId, item: item._id }).sort({ date: -1 }).populate('createdBy', 'name').lean(),
  ]);
  const rows = [
    ...txns,
    ...adjustments.map((a) => ({ kind: 'adjustment', _id: a._id, type: a.kind === 'add' ? 'ADD_STOCK' : 'REDUCE_STOCK', number: '', partyName: a.details || 'Stock adjustment', date: a.date, qty: a.qty, unitName: item.baseUnit?.shortName, price: a.price, amount: round2(a.qty * a.price), status: 'COMPLETED' })),
  ];
  if (!types && item.type === 'product') {
    rows.push({ kind: 'opening', _id: item._id, type: 'OPENING_STOCK', number: '', partyName: 'Opening Stock', date: item.openingDate ?? item.createdAt, qty: item.openingQty, unitName: item.baseUnit?.shortName, price: item.openingPrice, amount: round2(item.openingQty * item.openingPrice), status: '' });
  }
  const rx = searchRegex(req.query.search);
  const filtered = rx ? rows.filter((r) => rx.test(String(r.number ?? '')) || rx.test(String(r.partyName ?? '')) || rx.test(String(r.type ?? ''))) : rows;
  filtered.sort((a, b) => new Date(b.date as Date).getTime() - new Date(a.date as Date).getTime());
  ok(res, filtered);
});

router.post('/', requirePermission('items.create'), validate(itemSchema), async (req, res) => {
  const ctx = ctxOf(req);
  const body = req.body as ItemBody;
  await assertUniqueName(ctx.companyId, body.name);
  await assertRefs(ctx.companyId, body);
  const code = body.code || (ctx.settings.items.enableItemCode ? await generateCode(ctx.companyId) : undefined);
  const item = await Item.create({ ...body, code, openingDate: body.openingDate ?? new Date(), company: ctx.companyId, createdBy: ctx.userId });
  await recalcItems(ctx.companyId, [item._id]);
  await audit(ctx, 'create', 'Item', item._id, `Item ${item.name} created`);
  created(res, await Item.findById(item._id).populate('category', 'name').populate('baseUnit secondaryUnit', 'name shortName').lean());
});

async function updateItem(ctx: Ctx, id: Types.ObjectId | string, body: ItemBody) {
  const item = await Item.findOne({ _id: id, company: ctx.companyId });
  if (!item) throw AppError.notFound('Item');
  await assertUniqueName(ctx.companyId, body.name, item._id);
  await assertRefs(ctx.companyId, body);
  const before = item.toObject();
  item.set({ ...body, code: body.code || item.code });
  for (const k of ['category', 'baseUnit', 'secondaryUnit'] as const) if (!body[k]) item.set(k, undefined);
  await item.save();
  await recalcItems(ctx.companyId, [item._id]);
  await audit(ctx, 'update', 'Item', item._id, `Item ${item.name} updated`, before, item.toObject());
  return Item.findById(item._id).populate('category', 'name').populate('baseUnit secondaryUnit', 'name shortName').lean();
}

async function assertItemDeletable(ctx: Ctx, item: { _id: Types.ObjectId; name: string }) {
  const used = await Transaction.countDocuments({ company: ctx.companyId, 'items.item': item._id });
  if (used) throw AppError.badRequest(`${item.name} is used in ${used} transaction(s). Mark it inactive instead.`);
}

async function deleteItem(ctx: Ctx, id: Types.ObjectId | string) {
  const item = await Item.findOne({ _id: id, company: ctx.companyId });
  if (!item) throw AppError.notFound('Item');
  await assertItemDeletable(ctx, item);
  await StockAdjustment.deleteMany({ company: ctx.companyId, item: item._id });
  await item.deleteOne();
  await audit(ctx, 'delete', 'Item', item._id, `Item ${item.name} deleted`, item.toObject());
}

registerApprovalHandler('item_update', { approve: (ctx, a) => updateItem(ctx, a.entityId!, itemSchema.parse(a.payload)) });
registerApprovalHandler('item_delete', { approve: (ctx, a) => deleteItem(ctx, a.entityId!) });

router.put('/:id', requirePermission('items.edit'), validate(itemSchema), async (req, res) => {
  const ctx = ctxOf(req);
  const body = req.body as ItemBody;
  const item = await Item.findOne({ _id: oid(req.params.id), company: ctx.companyId });
  if (!item) throw AppError.notFound('Item');
  if (needsApproval(ctx, 'items.edit')) {
    // Fail fast on a clash the approver could not fix anyway
    await assertUniqueName(ctx.companyId, body.name, item._id);
    await assertRefs(ctx.companyId, body);
    return queueForApproval(res, ctx, { kind: 'item_update', entity: 'Item', entityId: item._id, label: `Edit item ${item.name}`, payload: body, before: item.toObject() });
  }
  ok(res, await updateItem(ctx, item._id, body));
});

router.delete('/:id', requirePermission('items.delete'), async (req, res) => {
  const ctx = ctxOf(req);
  const item = await Item.findOne({ _id: oid(req.params.id), company: ctx.companyId });
  if (!item) throw AppError.notFound('Item');
  if (needsApproval(ctx, 'items.delete')) {
    await assertItemDeletable(ctx, item);
    return queueForApproval(res, ctx, { kind: 'item_delete', entity: 'Item', entityId: item._id, label: `Delete item ${item.name}`, before: item.toObject() });
  }
  await deleteItem(ctx, item._id);
  ok(res, { deleted: true });
});

/* ---------------- Stock adjustment ---------------- */

const adjustSchema = z.object({
  kind: z.enum(['add', 'reduce']),
  qty: z.coerce.number().positive('Quantity must be greater than 0'),
  price: money,
  date: z.coerce.date().default(() => new Date()),
  details: optStr,
});
type AdjustBody = z.infer<typeof adjustSchema>;

async function applyAdjustment(ctx: Ctx, itemId: Types.ObjectId | string, body: AdjustBody) {
  const item = await Item.findOne({ _id: itemId, company: ctx.companyId });
  if (!item) throw AppError.notFound('Item');
  if (item.type === 'service') throw AppError.badRequest('Stock cannot be adjusted for a service');
  if (body.kind === 'reduce' && !ctx.settings.transaction.allowNegativeStock && item.stock - body.qty < 0) {
    throw AppError.badRequest(`Not enough stock (available ${item.stock})`);
  }
  const adj = await StockAdjustment.create({ ...body, company: ctx.companyId, item: item._id, createdBy: ctx.userId });
  await recalcItems(ctx.companyId, [item._id]);
  await audit(ctx, 'adjust_stock', 'Item', item._id, `${body.kind === 'add' ? 'Added' : 'Reduced'} ${body.qty} stock of ${item.name}${body.details ? ` (${body.details})` : ''}`);
  return adj.toObject();
}

registerApprovalHandler('stock_adjustment', { approve: (ctx, a) => applyAdjustment(ctx, a.entityId!, adjustSchema.parse(a.payload)) });

router.post('/:id/adjust', requirePermission('items.adjust_stock'), validate(adjustSchema), async (req, res) => {
  const ctx = ctxOf(req);
  const item = await Item.findOne({ _id: oid(req.params.id), company: ctx.companyId }).lean();
  if (!item) throw AppError.notFound('Item');
  if (needsApproval(ctx, 'items.adjust_stock')) {
    return queueForApproval(res, ctx, {
      kind: 'stock_adjustment',
      entity: 'Item',
      entityId: item._id,
      label: `${req.body.kind === 'add' ? 'Add' : 'Reduce'} ${req.body.qty} stock of ${item.name}`,
      payload: req.body,
    });
  }
  created(res, await applyAdjustment(ctx, item._id, req.body as AdjustBody));
});

async function removeAdjustment(ctx: Ctx, adjId: Types.ObjectId | string) {
  const adj = await StockAdjustment.findOneAndDelete({ _id: adjId, company: ctx.companyId }).lean();
  if (!adj) throw AppError.notFound('Adjustment');
  await recalcItems(ctx.companyId, [adj.item]);
  await audit(ctx, 'delete', 'Item', adj.item, `Stock adjustment of ${adj.qty} removed`);
}

registerApprovalHandler('stock_adjustment_delete', { approve: (ctx, a) => removeAdjustment(ctx, a.entityId!) });

router.delete('/adjustments/:adjId', requirePermission('items.adjust_stock'), async (req, res) => {
  const ctx = ctxOf(req);
  const adj = await StockAdjustment.findOne({ _id: oid(req.params.adjId), company: ctx.companyId }).populate<{ item: { name: string } | null }>('item', 'name').lean();
  if (!adj) throw AppError.notFound('Adjustment');
  if (needsApproval(ctx, 'items.adjust_stock')) {
    return queueForApproval(res, ctx, {
      kind: 'stock_adjustment_delete',
      entity: 'StockAdjustment',
      entityId: adj._id,
      label: `Remove stock adjustment of ${adj.qty} (${adj.kind === 'add' ? 'added' : 'reduced'}) for ${adj.item?.name ?? 'item'}`,
      before: adj,
    });
  }
  await removeAdjustment(ctx, adj._id);
  ok(res, { deleted: true });
});

/** Quick price/stock lookup used by the invoice form */
router.get('/:id/price-info', requirePermission('items.view'), async (req, res) => {
  const ctx = ctxOf(req);
  const item = await Item.findOne({ _id: oid(req.params.id), company: ctx.companyId }).lean();
  if (!item) throw AppError.notFound('Item');
  const party = str(req.query.party);
  let lastPrice: number | undefined;
  if (party && Types.ObjectId.isValid(party)) {
    const type = (str(req.query.type) ?? 'SALE') as TxnType;
    const last = await Transaction.findOne({ company: ctx.companyId, party, type: TXN_CONFIG[type]?.side === 'purchase' ? 'PURCHASE' : 'SALE', 'items.item': item._id })
      .sort({ date: -1 })
      .select('items.$')
      .lean();
    lastPrice = last?.items?.[0]?.price;
  }
  ok(res, { stock: item.stock, salePrice: item.salePrice, purchasePrice: item.purchasePrice, wholesalePrice: item.wholesalePrice, minWholesaleQty: item.minWholesaleQty, lastPrice });
});

export default router;

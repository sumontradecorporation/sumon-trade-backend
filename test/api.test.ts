/**
 * End-to-end API tests against a real MongoDB (database sumon_trade_test is dropped first).
 * Run: npm test   (MongoDB must be reachable at MONGODB_URI_TEST or mongodb://127.0.0.1:27017)
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.MONGODB_URI = process.env.MONGODB_URI_TEST ?? 'mongodb://127.0.0.1:27017/sumon_trade_test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-0001';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret-01';
process.env.NODE_ENV = 'test';
const STORAGE_DIR = './storage-test';
process.env.STORAGE_DIR = STORAGE_DIR;

const mongoose = (await import('mongoose')).default;
const { connectDB } = await import('../src/config/db.js');
const { createApp } = await import('../src/app.js');
const { User } = await import('../src/models/index.js');
const bcrypt = (await import('bcryptjs')).default;

let server: Server;
let base = '';

/** Minimal cookie-aware client. */
class Client {
  cookies = new Map<string, string>();
  company?: string;
  async req(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.company) headers['X-Company-Id'] = this.company;
    const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (v) this.cookies.set(k, v);
      else this.cookies.delete(k);
    }
    const json = (await res.json()) as { success: boolean; data: any; meta?: any; error?: { message: string } };
    return { status: res.status, ...json };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  put = (p: string, b?: unknown) => this.req('PUT', p, b ?? {});
  del = (p: string) => this.req('DELETE', p);
}

const superAdmin = new Client();
const owner = new Client();
const sales = new Client();
let companyId = '';
let otherCompanyId = '';
const ids: Record<string, string> = {};

before(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  await User.create({ name: 'Root', email: 'root@test.com', isSuperAdmin: true, passwordHash: await bcrypt.hash('Root@12345', 4) });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

describe('auth & multi-company', () => {
  test('rejects a wrong password', async () => {
    const r = await new Client().post('/auth/login', { identifier: 'root@test.com', password: 'nope' });
    assert.equal(r.status, 401);
  });

  test('super admin logs in and lands on the company list', async () => {
    const r = await superAdmin.post('/auth/login', { identifier: 'root@test.com', password: 'Root@12345' });
    assert.equal(r.status, 200);
    assert.equal(r.data.home, '/companies');
  });

  test('super admin creates companies (name and phone required)', async () => {
    const bad = await superAdmin.post('/companies', { name: 'X' });
    assert.equal(bad.status, 422);
    const a = await superAdmin.post('/companies', { name: 'Alpha Traders', phone: '9999999999' });
    assert.equal(a.status, 201);
    companyId = a.data._id;
    const b = await superAdmin.post('/companies', { name: 'Beta Stores', phone: '8888888888', email: 'beta@x.com' });
    otherCompanyId = b.data._id;
    const list = await superAdmin.get('/companies');
    assert.equal(list.data.length, 2);
  });

  test('super admin creates the company admin and a salesman inside the company', async () => {
    superAdmin.company = companyId;
    const roles = await superAdmin.get('/roles');
    const admin = roles.data.find((r: any) => r.name === 'Admin');
    const salesman = roles.data.find((r: any) => r.name === 'Salesman');
    assert.ok(admin && salesman);
    const u1 = await superAdmin.post('/users', { name: 'Owner', email: 'owner@alpha.com', password: 'Owner@123', role: admin._id });
    assert.equal(u1.status, 201);
    const u2 = await superAdmin.post('/users', { name: 'Sam', phone: '7000000000', password: 'Sales@123', role: salesman._id });
    assert.equal(u2.status, 201);
  });

  test('company users land on their own dashboard and can switch into another company', async () => {
    const r = await owner.post('/auth/login', { identifier: 'owner@alpha.com', password: 'Owner@123' });
    assert.equal(r.data.home, `/c/${companyId}/dashboard`);
    const list = await owner.get('/companies');
    assert.equal(list.data.length, 2, 'every active company is listed');
    assert.equal(list.data[0].stats, undefined, 'cross-company figures are for super admins');
    const create = await owner.post('/companies', { name: 'Hack', phone: '123456' });
    assert.equal(create.status, 403, 'only the super admin creates companies');
    owner.company = otherCompanyId;
    const there = await owner.get('/parties');
    assert.equal(there.status, 200);
    owner.company = companyId;
    const s = await sales.post('/auth/login', { identifier: '7000000000', password: 'Sales@123' });
    assert.equal(s.status, 200);
    sales.company = companyId;
  });

  test('salesman permissions are enforced', async () => {
    assert.equal((await sales.get('/settings/backup')).status, 403);
    assert.equal((await sales.get('/transactions?type=PURCHASE')).status, 403);
    assert.equal((await sales.get('/users')).status, 403);
    assert.equal((await sales.get('/transactions?type=SALE')).status, 200);
  });

  test('refresh token rotates the session', async () => {
    const r = await owner.post('/auth/refresh');
    assert.equal(r.status, 200);
    const me = await owner.get('/auth/me');
    assert.equal(me.data.user.email, 'owner@alpha.com');
  });
});

describe('masters', () => {
  test('creates party groups, parties and moves parties between groups', async () => {
    const g = await owner.post('/parties/groups', { name: 'Wholesale' });
    ids.group = g.data._id;
    const p1 = await owner.post('/parties', { name: 'Ravi Stores', phone: '9000000001', openingBalance: 1000, openingType: 'receive' });
    assert.equal(p1.status, 201);
    assert.equal(p1.data.balance, 1000);
    ids.customer = p1.data._id;
    const p2 = await owner.post('/parties', { name: 'Supply Co', openingBalance: 500, openingType: 'pay' });
    assert.equal(p2.data.balance, -500);
    ids.supplier = p2.data._id;
    const dup = await owner.post('/parties', { name: 'ravi stores' });
    assert.equal(dup.status, 409);
    const mv = await owner.post('/parties/move-group', { parties: [ids.customer], group: ids.group });
    assert.equal(mv.data.moved, 1);
    const groups = await owner.get('/parties/groups');
    assert.equal(groups.data.groups.find((x: any) => x._id === ids.group).parties, 1);
  });

  test('imports parties from a sheet with a check on every row', async () => {
    const csv = [
      'Party Name*,Phone,Email,BIN,VAT Type,Division,Billing Address,Shipping Address,Group,Party Type,Opening Balance,Balance Type,Credit Limit,Notes',
      'Kiran Traders,01712345678,kiran@example.com,000123456-0101,,Dhaka,,,Retail,Customer,"2,500",To receive,10000,',
      'ravi stores,,,,,,,,,,,,,',
      'Bad Row,12,not-an-email,XYZ,Weird,Atlantis,,,,Agent,abc,Maybe,,',
      'Old Name Co,,,,,chittagong,,,Suppliers,Supplier,-750,,,',
    ].join('\n');
    const upload = async (c: Client) => {
      const fd = new FormData();
      fd.append('file', new Blob([csv], { type: 'text/csv' }), 'parties.csv');
      const cookie = [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(`${base}/api/v1/parties/import/parse`, { method: 'POST', headers: { Cookie: cookie, 'X-Company-Id': companyId }, body: fd });
      return { status: res.status, ...((await res.json()) as { data: any }) };
    };
    assert.equal((await upload(sales)).status, 403, 'creating parties does not include importing them');

    const parsed = await upload(owner);
    assert.equal(parsed.status, 200);
    const [kiran, ravi, bad, old] = parsed.data.rows;
    assert.deepEqual(kiran.errors, []);
    assert.equal(kiran.gstType, 'regular', 'a BIN without a VAT type means a VAT registration');
    assert.equal(kiran.state, 'Dhaka');
    assert.equal(kiran.openingBalance, 2500);
    assert.deepEqual(ravi.errors, ['Already exists']);
    for (const msg of [/Phone/, /Email/, /BIN/, /VAT Type/, /Atlantis/, /Party Type/, /Opening Balance/, /Balance Type/]) assert.ok(bad.errors.some((e: string) => msg.test(e)), `${msg} in ${bad.errors}`);
    assert.equal(old.state, 'Chattogram', 'old spellings map to the official division name');
    assert.equal(old.openingType, 'pay', 'a negative balance without a type is owed to the party');
    assert.equal(old.openingBalance, 750);

    const valid = parsed.data.rows.filter((r: any) => !r.errors.length).map(({ row: _r, errors: _e, ...rest }: any) => rest);
    assert.equal((await sales.post('/parties/bulk', { parties: valid })).status, 403);
    const done = await owner.post('/parties/bulk', { parties: valid });
    assert.equal(done.status, 200);
    assert.equal(done.data.created, 2);
    const again = await owner.post('/parties/bulk', { parties: valid });
    assert.equal(again.data.created, 0);
    assert.equal(again.data.skipped.length, 2);

    const list = (await owner.get('/parties?search=Kiran Traders')).data;
    assert.equal(list[0].balance, 2500);
    assert.equal(list[0].group.name, 'Retail');
    assert.equal((await owner.get('/parties?search=Old Name Co')).data[0].balance, -750);
    assert.equal((await owner.post('/parties/bulk', { parties: [{ name: 'Nowhere Ltd', state: 'Atlantis' }] })).status, 422, 'the API checks the division too');

    const xlsx = await fetch(`${base}/api/v1/parties/export`, { headers: { Cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'X-Company-Id': companyId } });
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get('content-type') ?? '', /spreadsheetml/);
  });

  test('item import keeps item codes and HS codes with leading zeros', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['Item Name*,Item Code,HS Code,Sale Price\nAssam Tea 1kg,00123,0902,450\n'], { type: 'text/csv' }), 'items.csv');
    const cookie = [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${base}/api/v1/items/import/parse`, { method: 'POST', headers: { Cookie: cookie, 'X-Company-Id': companyId }, body: fd });
    assert.equal(res.status, 200);
    const [row] = ((await res.json()) as { data: { rows: any[] } }).data.rows;
    assert.deepEqual([row.code, row.hsn, row.salePrice, row.errors], ['00123', '0902', 450, []]);
  });

  test('creates units, a conversion, a category and items with opening stock', async () => {
    const units = (await owner.get('/items/units')).data.units;
    const box = units.find((u: any) => u.shortName === 'BOX')._id;
    const pcs = units.find((u: any) => u.shortName === 'PCS')._id;
    ids.box = box;
    ids.pcs = pcs;
    const conv = await owner.post('/items/unit-conversions', { baseUnit: box, secondaryUnit: pcs, rate: 12 });
    assert.equal(conv.status, 201);
    const cat = await owner.post('/items/categories', { name: 'Snacks' });
    const code = await owner.get('/items/next-code');
    assert.match(code.data.code, /^ITM\d+/);
    const it = await owner.post('/items', {
      name: 'Biscuit Box', category: cat.data._id, baseUnit: box, secondaryUnit: pcs, conversionRate: 12,
      salePrice: 240, purchasePrice: 180, taxRate: 18, openingQty: 10, openingPrice: 180, minStock: 2,
    });
    assert.equal(it.status, 201);
    assert.equal(it.data.stock, 10);
    ids.item = it.data._id;
  });

  test('stock adjustment adds and reduces stock', async () => {
    await owner.post(`/items/${ids.item}/adjust`, { kind: 'add', qty: 5, price: 180 });
    await owner.post(`/items/${ids.item}/adjust`, { kind: 'reduce', qty: 3, details: 'Damaged' });
    const it = await owner.get(`/items/${ids.item}`);
    assert.equal(it.data.stock, 12);
  });

  test('bulk update changes only the fields it is sent', async () => {
    const before = (await owner.get(`/items/${ids.item}`)).data;
    const r = await owner.put('/items/bulk-update', { items: [{ id: ids.item, salePrice: 250, taxRate: 12 }] });
    assert.equal(r.status, 200);
    assert.equal(r.data.updated, 1);
    const after = (await owner.get(`/items/${ids.item}`)).data;
    assert.equal(after.salePrice, 250);
    assert.equal(after.taxRate, 12);
    assert.equal(after.purchasePrice, before.purchasePrice);
    assert.equal(after.stock, before.stock);
    assert.equal(after.category._id, before.category._id);
    assert.equal((await owner.put('/items/bulk-update', { items: [{ id: ids.item, salePrice: 250 }] })).data.updated, 0, 'an unchanged value is not an update');
    assert.equal((await sales.put('/items/bulk-update', { items: [{ id: ids.item, salePrice: 1 }] })).status, 403);
    const foreign = await owner.put('/items/bulk-update', { items: [{ id: ids.item, category: '64b000000000000000000000' }] });
    assert.equal(foreign.data.skipped.length, 1, 'a category of another company is refused');
    await owner.put('/items/bulk-update', { items: [{ id: ids.item, salePrice: 240, taxRate: 18 }] });
  });

  test('items without a code get one for barcode labels', async () => {
    await owner.put('/settings/section/items', { enableItemCode: false });
    const loose = await owner.post('/items', { name: 'Loose Sugar', salePrice: 45 });
    await owner.put('/settings/section/items', { enableItemCode: true });
    assert.equal(loose.data.code, undefined);
    const r = await owner.post('/items/assign-codes', { items: [loose.data._id, ids.item] });
    assert.equal(r.status, 200);
    assert.match(r.data.codes[loose.data._id], /^ITM\d{5}$/);
    assert.equal(r.data.codes[ids.item], undefined, 'an item that has a code keeps it');
    assert.equal((await sales.post('/items/assign-codes', { items: [loose.data._id] })).status, 403);
  });
});

describe('sales flow', () => {
  test('sale invoice reduces stock (incl. secondary unit) and raises the receivable', async () => {
    const r = await owner.post('/transactions', {
      type: 'SALE', party: ids.customer, date: new Date().toISOString(),
      items: [
        { item: ids.item, name: 'Biscuit Box', qty: 2, unit: ids.box, price: 240, taxRate: 18 },
        { item: ids.item, name: 'Biscuit Box', qty: 6, unit: ids.pcs, price: 20, taxRate: 18 },
      ],
      settled: 200,
    });
    assert.equal(r.status, 201, r.error?.message);
    // 2×240 + 6×20 = 600 + 18% = 708
    assert.equal(r.data.total, 708);
    assert.equal(r.data.balance, 508);
    assert.equal(r.data.status, 'PARTIAL');
    assert.match(r.data.number, /^INV-1$/);
    ids.inv1 = r.data._id;
    const item = await owner.get(`/items/${ids.item}`);
    assert.equal(item.data.stock, 9.5); // 12 - 2 boxes - 6 pcs (0.5 box)
    const party = await owner.get(`/parties/${ids.customer}`);
    assert.equal(party.data.balance, 1000 + 508);
  });

  test('payment in auto-allocates to the oldest open invoice', async () => {
    const inv2 = await owner.post('/transactions', { type: 'SALE', party: ids.customer, items: [{ item: ids.item, name: 'Biscuit Box', qty: 1, unit: ids.box, price: 100, taxRate: 0 }] });
    ids.inv2 = inv2.data._id;
    const pay = await owner.post('/transactions', { type: 'PAYMENT_IN', party: ids.customer, amount: 550 });
    assert.equal(pay.status, 201);
    assert.equal(pay.data.allocations.length, 2);
    ids.pay1 = pay.data._id;
    const i1 = await owner.get(`/transactions/${ids.inv1}`);
    assert.equal(i1.data.status, 'PAID');
    const i2 = await owner.get(`/transactions/${ids.inv2}`);
    assert.equal(i2.data.balance, 58);
    assert.equal(i2.data.status, 'PARTIAL');
    const party = await owner.get(`/parties/${ids.customer}`);
    assert.equal(party.data.balance, 1000 + 508 + 100 - 550);
  });

  test('editing an invoice below its payments trims the allocation', async () => {
    const i1 = (await owner.get(`/transactions/${ids.inv1}`)).data;
    const body = { type: 'SALE', party: ids.customer, date: i1.date, number: i1.number, items: [{ item: ids.item, name: 'Biscuit Box', qty: 1, unit: ids.box, price: 300, taxRate: 0 }], settled: 200 };
    const r = await owner.put(`/transactions/${ids.inv1}`, body);
    assert.equal(r.status, 200, r.error?.message);
    assert.equal(r.data.total, 300);
    const pay = await owner.get(`/transactions/${ids.pay1}`);
    const alloc = pay.data.allocations.find((a: any) => a.transaction === ids.inv1);
    assert.equal(alloc.amount, 100);
    assert.equal(pay.data.balance, 550 - 100 - 42);
  });

  test('cancelling an invoice restores stock and unlinks payments', async () => {
    const stockBefore = (await owner.get(`/items/${ids.item}`)).data.stock;
    const r = await owner.post(`/transactions/${ids.inv2}/cancel`, { reason: 'Customer refused' });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'CANCELLED');
    const stockAfter = (await owner.get(`/items/${ids.item}`)).data.stock;
    assert.equal(stockAfter, stockBefore + 1);
    const pay = await owner.get(`/transactions/${ids.pay1}`);
    assert.ok(!pay.data.allocations.some((a: any) => a.transaction === ids.inv2));
  });

  test('estimate converts to sale and reopens when the sale is deleted', async () => {
    const est = await owner.post('/transactions', { type: 'ESTIMATE', party: ids.customer, items: [{ item: ids.item, name: 'Biscuit Box', qty: 1, unit: ids.box, price: 250 }] });
    assert.equal(est.data.status, 'OPEN');
    const sale = await owner.post('/transactions', { type: 'SALE', party: ids.customer, sourceId: est.data._id, items: [{ item: ids.item, name: 'Biscuit Box', qty: 1, unit: ids.box, price: 250 }] });
    assert.equal(sale.status, 201);
    assert.equal(sale.data.source.number, est.data.number);
    const estAfter = await owner.get(`/transactions/${est.data._id}`);
    assert.equal(estAfter.data.status, 'CONVERTED');
    assert.equal(estAfter.data.links[0].number, sale.data.number);
    const bad = await owner.post('/transactions', { type: 'PURCHASE', party: ids.customer, sourceId: est.data._id, items: [{ name: 'x', qty: 1, price: 1 }] });
    assert.equal(bad.status, 400);
    await owner.del(`/transactions/${sale.data._id}`);
    const reopened = await owner.get(`/transactions/${est.data._id}`);
    assert.equal(reopened.data.status, 'OPEN');
  });

  test('payment in never allocates to purchase bills of the same party', async () => {
    const pb = await owner.post('/transactions', { type: 'PURCHASE', party: ids.customer, items: [{ name: 'Service', qty: 1, price: 1000 }] });
    assert.equal(pb.status, 201);
    const pay = await owner.post('/transactions', { type: 'PAYMENT_IN', party: ids.customer, amount: 10 });
    assert.ok(pay.data.allocations.every((a: any) => a.transaction !== pb.data._id));
  });

  test('numbers are unique per type and the counter follows manual numbers', async () => {
    const r = await owner.post('/transactions', { type: 'SALE', number: 'INV-50', autoNumber: false, items: [{ name: 'Misc', qty: 1, price: 10 }], settled: 10 });
    assert.equal(r.data.number, 'INV-50');
    const dup = await owner.post('/transactions', { type: 'SALE', number: 'INV-50', autoNumber: false, items: [{ name: 'Misc', qty: 1, price: 10 }], settled: 10 });
    assert.equal(dup.status, 409);
    const next = await owner.get('/transactions/next-number?type=SALE');
    assert.equal(next.data.number, 'INV-51');
  });

  test('only a cash sale or purchase, paid in full, goes without a party', async () => {
    const items = [{ name: 'Misc', qty: 1, price: 40 }];
    const credit = await owner.post('/transactions', { type: 'SALE', items, settled: 10 });
    assert.equal(credit.status, 400);
    assert.match(credit.error.message, /cash sale/);
    const estimate = await owner.post('/transactions', { type: 'ESTIMATE', items });
    assert.equal(estimate.status, 400);
    const cashPurchase = await owner.post('/transactions', { type: 'PURCHASE', items, settled: 40 });
    assert.equal(cashPurchase.status, 201, cashPurchase.error?.message);
    assert.equal(cashPurchase.data.status, 'PAID');
    await owner.del(`/transactions/${cashPurchase.data._id}`);
  });
});

describe('purchase, expense, cash', () => {
  test('purchase raises stock and payable; payment out settles it', async () => {
    const pb = await owner.post('/transactions', { type: 'PURCHASE', party: ids.supplier, items: [{ item: ids.item, name: 'Biscuit Box', qty: 10, unit: ids.box, price: 180 }] });
    assert.equal(pb.data.total, 1800);
    const sup = await owner.get(`/parties/${ids.supplier}`);
    assert.equal(sup.data.balance, -2300);
    const pay = await owner.post('/transactions', { type: 'PAYMENT_OUT', party: ids.supplier, amount: 1800 });
    assert.equal(pay.data.allocations[0].transaction, pb.data._id);
    const bill = await owner.get(`/transactions/${pb.data._id}`);
    assert.equal(bill.data.status, 'PAID');
  });

  test('expense needs a category and reduces cash', async () => {
    const cats = await owner.get('/finance/expense-categories');
    const rent = cats.data.find((c: any) => c.name === 'Rent');
    const noCat = await owner.post('/transactions', { type: 'EXPENSE', items: [{ name: 'Rent', qty: 1, price: 5000 }], settled: 5000 });
    assert.equal(noCat.status, 400);
    const before = (await owner.get('/finance/accounts')).meta.summary.cash;
    const e = await owner.post('/transactions', { type: 'EXPENSE', expenseCategory: rent._id, items: [{ name: 'Rent', qty: 1, price: 5000 }], settled: 5000 });
    assert.equal(e.status, 201);
    const afterCash = (await owner.get('/finance/accounts')).meta.summary.cash;
    assert.equal(afterCash, before - 5000);
  });
});

describe('proforma, cheques and loans', () => {
  const ymd = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
  const balanceOf = async (id: string) => (await owner.get('/finance/accounts')).data.find((a: any) => a._id === id).balance;
  const partyBalance = async (id: string) => (await owner.get(`/parties/${id}`)).data.balance;
  const line = (price: number) => [{ item: ids.item, name: 'Biscuit Box', qty: 1, unit: ids.box, price, taxRate: 0 }];

  test('a proforma invoice changes no stock or balance and converts to a sale invoice', async () => {
    const stock = (await owner.get(`/items/${ids.item}`)).data.stock;
    const owed = await partyBalance(ids.customer);
    const pi = await owner.post('/transactions', { type: 'PROFORMA', party: ids.customer, items: line(300), terms: 'Advance before dispatch' });
    assert.equal(pi.status, 201, pi.error?.message);
    assert.equal(pi.data.number, 'PI-1');
    assert.equal(pi.data.status, 'OPEN');
    assert.equal((await owner.get(`/items/${ids.item}`)).data.stock, stock);
    assert.equal(await partyBalance(ids.customer), owed);
    // The salesman role includes proforma invoices
    const bySales = await sales.post('/transactions', { type: 'PROFORMA', party: ids.customer, items: line(100) });
    assert.equal(bySales.status, 201, bySales.error?.message);
    const inv = await owner.post('/transactions', { type: 'SALE', party: ids.customer, sourceId: pi.data._id, items: line(300) });
    assert.equal(inv.status, 201, inv.error?.message);
    assert.equal((await owner.get(`/transactions/${pi.data._id}`)).data.status, 'CONVERTED');
    const order = await owner.post('/transactions', { type: 'SALE_ORDER', party: ids.customer, sourceId: bySales.data._id, items: line(100) });
    assert.equal(order.status, 201, order.error?.message);
    await owner.del(`/transactions/${inv.data._id}`);
    await owner.del(`/transactions/${order.data._id}`);
    assert.equal((await owner.get(`/transactions/${pi.data._id}`)).data.status, 'OPEN');
    const dash = await owner.get('/dashboard');
    assert.equal(dash.data.openDocs.PROFORMA.count, 2);
  });

  test('a cheque counts against the party at once and reaches the bank only when it is deposited', async () => {
    const bank = await owner.post('/finance/accounts', { name: 'SBI Current', kind: 'bank', openingBalance: 1000 });
    assert.equal(bank.status, 201);
    ids.bank = bank.data._id;
    const owed = await partyBalance(ids.customer);
    const totalBefore = (await owner.get('/finance/accounts')).data.reduce((s: number, a: any) => s + a.balance, 0);
    const pay = await owner.post('/transactions', { type: 'PAYMENT_IN', party: ids.customer, amount: 400, paymentMode: 'cheque', paymentRef: '000123' });
    assert.equal(pay.status, 201, pay.error?.message);
    assert.equal(pay.data.paymentType, 'Cheque');
    assert.equal(pay.data.cheque.status, 'OPEN');
    assert.equal(pay.data.paymentAccount, undefined);
    assert.equal(await partyBalance(ids.customer), owed - 400);
    assert.equal((await owner.get('/finance/accounts')).data.reduce((s: number, a: any) => s + a.balance, 0), totalBefore);

    const open = await owner.get('/finance/cheques?status=open');
    const row = open.data.find((c: any) => c._id === pay.data._id);
    assert.ok(row, 'open cheque listed');
    assert.equal(row.direction, 'in');
    assert.equal(row.amount, 400);
    assert.equal(row.chequeNo, '000123');
    assert.equal(open.meta.summary.received.total, 400);
    assert.equal((await sales.get('/finance/cheques')).status, 403);
    assert.equal((await sales.post(`/finance/cheques/${pay.data._id}/close`, { account: ids.bank, date: ymd(0) })).status, 403);

    assert.equal((await owner.post(`/finance/cheques/${pay.data._id}/close`, { account: ids.bank, date: '2000-01-01' })).status, 400);
    const dep = await owner.post(`/finance/cheques/${pay.data._id}/close`, { account: ids.bank, date: ymd(0) });
    assert.equal(dep.status, 200, dep.error?.message);
    assert.equal((await owner.post(`/finance/cheques/${pay.data._id}/close`, { account: ids.bank, date: ymd(0) })).status, 409);
    assert.equal(await balanceOf(ids.bank), 1400);
    const detail = await owner.get(`/transactions/${pay.data._id}`);
    assert.equal(detail.data.cheque.status, 'CLOSED');
    assert.equal(detail.data.cheque.account.name, 'SBI Current');

    const st = await owner.get(`/finance/accounts/${ids.bank}/statement`);
    const dr = st.data.rows.find((r: any) => r.kind === 'cheque');
    assert.equal(dr.label, 'Cheque deposited');
    assert.equal(dr.link.id, pay.data._id);
    assert.equal(dr.deletable, false);
    assert.equal((await owner.del(`/finance/entries/${dr._id}`)).status, 400);

    // While it has cleared, the payment keeps its amount and cannot be deleted
    const body = { type: 'PAYMENT_IN', party: ids.customer, amount: 400, paymentMode: 'cheque', paymentRef: '000123' };
    assert.equal((await owner.put(`/transactions/${pay.data._id}`, { ...body, amount: 450 })).status, 400);
    assert.equal((await owner.put(`/transactions/${pay.data._id}`, { ...body, paymentMode: 'account' })).status, 400);
    const note = await owner.put(`/transactions/${pay.data._id}`, { ...body, description: 'Cheque from the counter' });
    assert.equal(note.status, 200, note.error?.message);
    assert.equal(note.data.cheque.status, 'CLOSED');
    assert.equal((await owner.del(`/transactions/${pay.data._id}`)).status, 400);

    const re = await owner.post(`/finance/cheques/${pay.data._id}/reopen`);
    assert.equal(re.status, 200);
    assert.equal(await balanceOf(ids.bank), 1000);
    assert.equal((await owner.get(`/finance/accounts/${ids.bank}/statement`)).data.rows.length, 0);
    assert.equal((await owner.del(`/transactions/${pay.data._id}`)).status, 200);
    assert.equal(await partyBalance(ids.customer), owed);

    // An issued cheque leaves the bank when it is withdrawn
    const out = await owner.post('/transactions', { type: 'PAYMENT_OUT', party: ids.supplier, amount: 300, paymentMode: 'cheque', paymentRef: '900001' });
    assert.equal(out.status, 201, out.error?.message);
    const issued = await owner.get('/finance/cheques?direction=out');
    assert.equal(issued.data[0]._id, out.data._id);
    assert.equal(issued.meta.summary.issued.total, 300);
    const wd = await owner.post(`/finance/cheques/${out.data._id}/close`, { account: ids.bank, date: ymd(0) });
    assert.equal(wd.status, 200, wd.error?.message);
    assert.equal(await balanceOf(ids.bank), 700);
    assert.equal((await owner.get(`/finance/accounts/${ids.bank}/statement`)).data.rows[0].label, 'Cheque withdrawn');
    assert.equal((await owner.get('/finance/cheques?status=closed&direction=out')).data[0].account.name, 'SBI Current');
    assert.equal((await owner.del(`/finance/accounts/${ids.bank}`)).status, 400);

    // The amount received on an invoice can be a cheque too; cancelling the invoice drops an open cheque
    const inv = await owner.post('/transactions', { type: 'SALE', party: ids.customer, items: line(500), settled: 500, paymentMode: 'cheque' });
    assert.equal(inv.status, 201, inv.error?.message);
    assert.equal(inv.data.status, 'PAID');
    assert.equal(inv.data.cheque.status, 'OPEN');
    assert.ok((await owner.get('/finance/cheques?status=open')).data.some((c: any) => c._id === inv.data._id && c.amount === 500));
    assert.equal((await owner.post(`/transactions/${inv.data._id}/cancel`, { reason: 'Test' })).status, 200);
    assert.ok(!(await owner.get('/finance/cheques')).data.some((c: any) => c._id === inv.data._id));
  });

  test('a loan brings money in; EMIs split into principal and interest; statements and reports agree', async () => {
    const start = await balanceOf(ids.bank);
    assert.equal((await owner.post('/finance/loans', { name: 'Car loan', openingBalance: 0, openingDate: ymd(10) })).status, 422);
    assert.equal((await owner.post('/finance/loans', { name: 'Car loan', openingBalance: 100000, openingDate: ymd(10), processingFee: 1000 })).status, 422);
    const loan = await owner.post('/finance/loans', { name: 'Car loan', lender: 'SBI', openingBalance: 100000, openingDate: ymd(10), receivedIn: ids.bank, processingFee: 1000, feePaidFrom: ids.bank, interestRate: 12, termMonths: 12 });
    assert.equal(loan.status, 201, loan.error?.message);
    ids.loan = loan.data._id;
    assert.equal((await owner.post('/finance/loans', { name: 'Car loan', openingBalance: 5000, openingDate: ymd(1) })).status, 409);
    assert.equal(await balanceOf(ids.bank), start + 99000);
    assert.equal((await sales.get('/finance/loans')).status, 403);

    const emi = await owner.post(`/finance/loans/${ids.loan}/entries`, { kind: 'payment', principal: 8000, interest: 1000, account: ids.bank, date: ymd(5) });
    assert.equal(emi.status, 201, emi.error?.message);
    assert.equal(emi.data.amount, 9000);
    assert.equal((await owner.post(`/finance/loans/${ids.loan}/entries`, { kind: 'payment', principal: 200000, account: ids.bank, date: ymd(4) })).status, 400);
    assert.equal((await owner.post(`/finance/loans/${ids.loan}/entries`, { kind: 'payment', principal: 100, account: ids.bank, date: ymd(20) })).status, 400);
    assert.equal((await owner.post(`/finance/loans/${ids.loan}/entries`, { kind: 'charge', amount: 0, account: ids.bank, date: ymd(4) })).status, 400);
    const more = await owner.post(`/finance/loans/${ids.loan}/entries`, { kind: 'increase', amount: 20000, account: ids.bank, date: ymd(3) });
    assert.equal(more.status, 201, more.error?.message);
    assert.equal((await owner.post(`/finance/loans/${ids.loan}/entries`, { kind: 'charge', amount: 500, account: ids.bank, date: ymd(2), description: 'Late fee' })).status, 201);
    assert.equal(await balanceOf(ids.bank), start + 99000 - 9000 + 20000 - 500);

    const list = await owner.get('/finance/loans');
    const l = list.data.find((x: any) => x._id === ids.loan);
    assert.equal(l.balance, 112000);
    assert.equal(l.interestPaid, 1000);
    assert.equal(l.chargesPaid, 1500);
    assert.equal(l.receivedIn.name, 'SBI Current');
    const st = await owner.get(`/finance/loans/${ids.loan}/statement`);
    assert.deepEqual(st.data.totals, { outstanding: 112000, taken: 120000, principalPaid: 8000, interestPaid: 1000, charges: 1500 });
    assert.equal(st.data.rows[0].label, 'Charges paid');
    assert.equal(st.data.rows[st.data.rows.length - 1].label, 'Loan taken');

    const bankRows = (await owner.get(`/finance/accounts/${ids.bank}/statement`)).data.rows.filter((r: any) => r.kind === 'loan');
    assert.deepEqual(bankRows.map((r: any) => [r.label, r.amount]).reverse(), [['Loan received', 100000], ['Loan processing fee', -1000], ['Loan EMI paid', -9000], ['More loan taken', 20000], ['Loan charges', -500]]);

    // Cash flow, bank statement report and Cash & Bank agree
    const flow = await owner.get(`/reports/cash-flow?account=${ids.bank}`);
    assert.equal(flow.data.summary.find((x: any) => x.label === 'Closing').value, await balanceOf(ids.bank));
    const all = await owner.get('/reports/cash-flow');
    const total = (await owner.get('/finance/accounts')).data.reduce((s: number, a: any) => s + a.balance, 0);
    assert.equal(all.data.summary.find((x: any) => x.label === 'Closing').value, Math.round(total * 100) / 100);

    const pl = await owner.get(`/reports/profit-loss?from=${ymd(10)}&to=${ymd(0)}`);
    assert.equal(pl.data.rows.find((r: any) => r.particular.startsWith('Loan Interest')).amount, -2500);
    const bs = await owner.get('/reports/balance-sheet');
    assert.equal(bs.data.rows.find((r: any) => r.particular === 'Loan: Car loan').amount, 112000);
    const rep = await owner.get(`/reports/loan-statement?loan=${ids.loan}`);
    assert.equal(rep.status, 200, rep.error?.message);
    assert.equal(rep.data.summary.find((x: any) => x.label === 'Still owed').value, 112000);

    const edit = await owner.put(`/finance/loans/entries/${emi.data._id}`, { kind: 'payment', principal: 9000, interest: 1000, account: ids.bank, date: ymd(5) });
    assert.equal(edit.status, 200, edit.error?.message);
    assert.equal(edit.data.amount, 10000);
    // The loan cannot start after its first entry, or be cut below what is already repaid
    assert.equal((await owner.put(`/finance/loans/${ids.loan}`, { name: 'Car loan', openingBalance: 100000, openingDate: ymd(4), receivedIn: ids.bank })).status, 400);
    // Extra loan that repayments already cover cannot be removed
    const small = await owner.post('/finance/loans', { name: 'Small loan', openingBalance: 1000, openingDate: ymd(10) });
    const top = await owner.post(`/finance/loans/${small.data._id}/entries`, { kind: 'increase', amount: 5000, account: ids.bank, date: ymd(6) });
    await owner.post(`/finance/loans/${small.data._id}/entries`, { kind: 'payment', principal: 5500, account: ids.bank, date: ymd(5) });
    assert.equal((await owner.del(`/finance/loans/entries/${top.data._id}`)).status, 400);
    // Lowering the extra loan below what the EMI already repaid is refused; down to exactly that is fine
    const lower = await owner.put(`/finance/loans/entries/${top.data._id}`, { kind: 'increase', amount: 1000, account: ids.bank, date: ymd(6) });
    assert.equal(lower.status, 400);
    assert.match(lower.error.message, /already repay ৳4,500/);
    // Changing it into a charge would remove the extra loan altogether
    const recast = await owner.put(`/finance/loans/entries/${top.data._id}`, { kind: 'charge', amount: 200, account: ids.bank, date: ymd(6) });
    assert.equal(recast.status, 400);
    assert.match(recast.error.message, /already repay ৳4,500/);
    assert.equal((await owner.put(`/finance/loans/entries/${top.data._id}`, { kind: 'increase', amount: 4500, account: ids.bank, date: ymd(6) })).status, 200);
    assert.equal((await owner.put(`/finance/loans/${small.data._id}`, { name: 'Small loan', openingBalance: 400, openingDate: ymd(10) })).status, 400);
    assert.equal((await owner.del(`/finance/loans/${small.data._id}`)).status, 200);
    assert.equal((await owner.del(`/finance/loans/entries/${more.data._id}`)).status, 200);
    assert.equal((await owner.del(`/finance/accounts/${ids.bank}`)).status, 400);
    assert.equal((await owner.del(`/finance/loans/${ids.loan}`)).status, 200);
    assert.equal(await balanceOf(ids.bank), start);
  });
});

describe('approvals', () => {
  test('staff delete becomes an approval request that the admin approves', async () => {
    const inv = await sales.post('/transactions', { type: 'SALE', party: ids.customer, items: [{ name: 'Misc', qty: 1, price: 99 }] });
    assert.equal(inv.status, 201);
    const del = await sales.del(`/transactions/${inv.data._id}`);
    assert.equal(del.status, 403); // salesman has no delete permission
    const cancel = await sales.post(`/transactions/${inv.data._id}/cancel`, { reason: 'typo' });
    assert.equal(cancel.status, 202);
    assert.equal(cancel.data.pendingApproval, true);
    const notes = await owner.get('/system/notifications');
    assert.ok(notes.meta.unread >= 1);
    assert.ok(notes.meta.pendingApprovals >= 1);
    const list = await owner.get('/system/approvals?status=pending');
    const a = list.data[0];
    const ok = await owner.post(`/system/approvals/${a._id}/decision`, { decision: 'approve', note: 'fine' });
    assert.equal(ok.status, 200);
    const doc = await owner.get(`/transactions/${inv.data._id}`);
    assert.equal(doc.data.status, 'CANCELLED');
    const history = await owner.get(`/transactions/${inv.data._id}/history`);
    assert.ok(history.data.logs.some((l: any) => l.action === 'cancel'));
  });

  test('a role can be granted actions "with approval"', async () => {
    const role = await owner.post('/roles', {
      name: 'Checker',
      permissions: ['items.view', 'items.create', 'items.delete', 'parties.view', 'parties.create', 'parties.edit', 'sale_invoice.view', 'sale_invoice.create', 'sale_invoice.delete'],
      approvalRequired: ['items.delete', 'parties.edit', 'items.edit', 'dashboard.view'],
    });
    assert.equal(role.status, 201);
    assert.deepEqual([...role.data.approvalRequired].sort(), ['items.delete', 'parties.edit'], 'only granted, approvable permissions are kept');
    assert.equal((await owner.post('/users', { name: 'Chad', email: 'checker@alpha.com', password: 'Checker@123', role: role.data._id })).status, 201);
    const checker = new Client();
    const login = await checker.post('/auth/login', { identifier: 'checker@alpha.com', password: 'Checker@123' });
    assert.deepEqual([...login.data.approvalRequired].sort(), ['items.delete', 'parties.edit']);
    checker.company = companyId;

    // Delete with approval: queued, then applied by the approver
    const item = await checker.post('/items', { name: 'Approval widget' });
    assert.equal(item.status, 201);
    const del = await checker.del(`/items/${item.data._id}`);
    assert.equal(del.status, 202);
    assert.equal((await checker.get(`/items/${item.data._id}`)).status, 200, 'still there until approved');
    assert.equal((await checker.del(`/items/${item.data._id}`)).status, 409, 'one pending request per change');
    const pending = (await owner.get('/system/approvals?status=pending&kind=item_delete')).data[0];
    assert.equal((await checker.post(`/system/approvals/${pending._id}/decision`, { decision: 'approve' })).status, 403, 'requesters cannot approve');
    assert.equal((await owner.post(`/system/approvals/${pending._id}/decision`, { decision: 'approve' })).status, 200);
    assert.equal((await checker.get(`/items/${item.data._id}`)).status, 404);

    // Edit with approval, declined: nothing changes
    const party = await checker.post('/parties', { name: 'Approval Traders' });
    const edit = await checker.put(`/parties/${party.data._id}`, { name: 'Renamed Traders' });
    assert.equal(edit.status, 202);
    const req = (await owner.get('/system/approvals?status=pending&kind=party_update')).data[0];
    assert.equal((await owner.post(`/system/approvals/${req._id}/decision`, { decision: 'reject', note: 'keep it' })).status, 200);
    assert.equal((await checker.get(`/parties/${party.data._id}`)).data.name, 'Approval Traders');

    // Allowed without approval: applies at once, and so does cancelling a document the role may delete
    const inv = await checker.post('/transactions', { type: 'SALE', party: party.data._id, items: [{ name: 'Misc', qty: 1, price: 10 }] });
    assert.equal(inv.status, 201);
    assert.equal((await checker.del(`/transactions/${inv.data._id}`)).status, 200);
  });
});

describe('permissions without a route guard', () => {
  test('a role with only the dashboard cannot read party totals, numbers or delete files', async () => {
    const role = await owner.post('/roles', { name: 'Viewer', permissions: ['dashboard.view'] });
    assert.equal(role.status, 201);
    assert.equal((await owner.post('/users', { name: 'Vik', email: 'viewer@alpha.com', password: 'Viewer@123', role: role.data._id })).status, 201);
    const viewer = new Client();
    assert.equal((await viewer.post('/auth/login', { identifier: 'viewer@alpha.com', password: 'Viewer@123' })).status, 200);
    viewer.company = companyId;
    assert.equal((await viewer.get(`/transactions/party/${ids.customer}/summary`)).status, 403);
    assert.equal((await viewer.get('/transactions/next-number?type=SALE')).status, 403);
    assert.equal((await sales.get('/transactions/next-number?type=SALE')).status, 200);

    const cookie = (c: Client) => [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const fd = new FormData();
    fd.append('files', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
    const up = await fetch(`${base}/api/v1/files`, { method: 'POST', headers: { Cookie: cookie(sales), 'X-Company-Id': companyId }, body: fd });
    assert.equal(up.status, 201);
    const fileId = ((await up.json()) as { data: { _id: string }[] }).data[0]._id;
    assert.equal((await viewer.del(`/files/${fileId}`)).status, 403);
    assert.equal((await sales.del(`/files/${fileId}`)).status, 200);
  });
});

describe('settings', () => {
  test('mailbox passwords are stored encrypted and never returned', async () => {
    const { Company } = await import('../src/models/index.js');
    const { openSecret } = await import('../src/core/secrets.js');
    const saved = await owner.put('/settings/section/email', { smtpHost: 'smtp.example.com', smtpUser: 'billing@example.com', smtpPass: 'Sm7p-Secret' });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.email.smtpPass, '********');
    const stored = (await Company.findById(companyId).lean())!.settings.email;
    assert.match(stored.smtpPass, /^enc:v1:/);
    assert.equal(openSecret(stored.smtpPass), 'Sm7p-Secret');
    // Saving the form again with the mask keeps the password
    await owner.put('/settings/section/email', { smtpHost: 'smtp2.example.com', smtpPass: '********' });
    const kept = (await Company.findById(companyId).lean())!.settings.email;
    assert.equal(kept.smtpHost, 'smtp2.example.com');
    assert.equal(openSecret(kept.smtpPass), 'Sm7p-Secret');
    const read = await sales.get('/settings');
    assert.equal(read.data.settings.email.smtpPass, '********');
  });
});

describe('reports & dashboard', () => {
  test('every report runs', async () => {
    const list = await owner.get('/reports');
    assert.ok(list.data.length >= 30);
    for (const r of list.data) {
      const q = r.required?.includes('party') ? `?party=${ids.customer}` : r.required?.includes('item') ? `?item=${ids.item}` : r.required?.includes('account') ? `?account=${ids.bank}` : '';
      if (r.required?.includes('loan')) {
        const loan = await owner.post('/finance/loans', { name: `Report loan ${r.key}`, openingBalance: 5000, openingDate: new Date().toISOString().slice(0, 10) });
        const res = await owner.get(`/reports/${r.key}?loan=${loan.data._id}`);
        assert.equal(res.status, 200, `${r.key}: ${res.error?.message}`);
        assert.equal(res.data.rows.length, 1);
        continue;
      }
      const res = await owner.get(`/reports/${r.key}${q}`);
      assert.equal(res.status, 200, `${r.key}: ${res.error?.message}`);
      assert.ok(Array.isArray(res.data.rows));
    }
  });

  test('party statement closes at the party balance', async () => {
    const st = await owner.get(`/reports/party-statement?party=${ids.customer}`);
    const party = await owner.get(`/parties/${ids.customer}`);
    const last = st.data.rows[st.data.rows.length - 1];
    assert.equal(last.balance, party.data.balance);
  });

  test('dashboard returns KPIs', async () => {
    const d = await owner.get('/dashboard');
    assert.equal(d.status, 200);
    assert.ok(d.data.monthly.length === 12);
  });
});

describe('quick search', () => {
  test('finds parties, items and documents, limited to what the role may see', async () => {
    const r = await owner.get('/system/search?q=ravi');
    assert.equal(r.status, 200);
    assert.ok(r.data.parties.some((p: any) => p.name === 'Ravi Stores'));
    assert.ok((await owner.get('/system/search?q=biscuit')).data.items.some((i: any) => i.name === 'Biscuit Box'));
    const owners = await owner.get('/system/search?q=PB-');
    assert.ok(owners.data.documents.some((d: any) => d.type === 'PURCHASE'), 'the admin finds purchase bills by number');
    const salesman = await sales.get('/system/search?q=PB-');
    assert.equal(salesman.data.documents.filter((d: any) => d.type === 'PURCHASE').length, 0, 'the salesman has no purchase permission');
    assert.equal(salesman.data.employees.length, 0);
    assert.deepEqual((await owner.get('/system/search?q=')).data.documents, []);
    assert.equal((await owner.get('/system/search?q=(.*')).status, 200, 'a search is text, never a pattern');
  });
});

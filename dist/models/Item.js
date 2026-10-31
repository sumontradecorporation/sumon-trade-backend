import { Schema, model } from 'mongoose';
import { baseOptions, companyRef, userRef } from './_base.js';
const itemSchema = new Schema({
    company: companyRef,
    type: { type: String, enum: ['product', 'service'], default: 'product' },
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true },
    hsn: { type: String, trim: true },
    category: { type: Schema.Types.ObjectId, ref: 'Category', index: true },
    baseUnit: { type: Schema.Types.ObjectId, ref: 'Unit' },
    secondaryUnit: { type: Schema.Types.ObjectId, ref: 'Unit' },
    /** 1 base unit = conversionRate secondary units */
    conversionRate: { type: Number, default: 1 },
    salePrice: { type: Number, default: 0 },
    saleTaxInclusive: { type: Boolean, default: false },
    wholesalePrice: { type: Number, default: 0 },
    minWholesaleQty: { type: Number, default: 0 },
    purchasePrice: { type: Number, default: 0 },
    purchaseTaxInclusive: { type: Boolean, default: false },
    mrp: Number,
    taxRate: { type: Number, default: 0 },
    openingQty: { type: Number, default: 0 },
    openingPrice: { type: Number, default: 0 },
    openingDate: { type: Date, default: () => new Date() },
    minStock: { type: Number, default: 0 },
    location: String,
    /** Derived by services/ledger.recalcItems – in base units. */
    stock: { type: Number, default: 0 },
    description: String,
    images: [{ type: Schema.Types.ObjectId, ref: 'FileAsset' }],
    isActive: { type: Boolean, default: true },
    createdBy: userRef,
}, baseOptions);
itemSchema.index({ company: 1, name: 1 });
itemSchema.index({ company: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string', $gt: '' } } });
export const Item = model('Item', itemSchema);
const categorySchema = new Schema({ company: companyRef, name: { type: String, required: true, trim: true } }, baseOptions);
categorySchema.index({ company: 1, name: 1 }, { unique: true });
export const Category = model('Category', categorySchema);
const unitSchema = new Schema({ company: companyRef, name: { type: String, required: true, trim: true }, shortName: { type: String, required: true, trim: true } }, baseOptions);
unitSchema.index({ company: 1, shortName: 1 }, { unique: true });
export const Unit = model('Unit', unitSchema);
const unitConversionSchema = new Schema({
    company: companyRef,
    baseUnit: { type: Schema.Types.ObjectId, ref: 'Unit', required: true },
    secondaryUnit: { type: Schema.Types.ObjectId, ref: 'Unit', required: true },
    rate: { type: Number, required: true, min: 0.000001 },
}, baseOptions);
unitConversionSchema.index({ company: 1, baseUnit: 1, secondaryUnit: 1 }, { unique: true });
export const UnitConversion = model('UnitConversion', unitConversionSchema);
const stockAdjustmentSchema = new Schema({
    company: companyRef,
    item: { type: Schema.Types.ObjectId, ref: 'Item', required: true, index: true },
    kind: { type: String, enum: ['add', 'reduce'], required: true },
    qty: { type: Number, required: true, min: 0 },
    price: { type: Number, default: 0 },
    date: { type: Date, default: () => new Date() },
    details: String,
    createdBy: userRef,
}, baseOptions);
export const StockAdjustment = model('StockAdjustment', stockAdjustmentSchema);
//# sourceMappingURL=Item.js.map
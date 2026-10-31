/**
 * Seeds the super admin and (with --demo) a fully populated demo company.
 *   npm run seed            -> super admin only (idempotent)
 *   npm run seed -- --demo  -> super admin + demo company with parties, items, invoices, staff
 *   npm run seed -- --reset --demo -> deletes the demo company (and its files) and creates it again
 */
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectDB, disconnectDB } from '../config/db.js';
import { resolveSettings } from '../core/settings.js';
import { ALL_PERMISSIONS } from '../core/permissions.js';
import { ApprovalRequest, Attendance, AuditLog, BankAccount, BankEntry, Category, Company, EmailMessage, Employee, ExpenseCategory, FileAsset, HrRequest, Item, LoanAccount, LoanEntry, Party, PartyGroup, Role, Transaction, Unit, User, } from '../models/index.js';
import { htmlToText } from '../services/mailer.js';
import { notifyPermission } from '../services/notify.js';
import { lowStockAlert } from '../services/automations.js';
import { hrRequestLabel } from '../modules/hr/labels.js';
import { bootstrapCompany } from '../services/bootstrap.js';
import { recalcItems, recalcParties } from '../services/ledger.js';
import { cancelTxn, computeLine, computeTotals, createTxn } from '../modules/transactions/service.js';
import { closeCheque } from '../modules/finance/cheques.js';
import { txnBodySchema } from '../modules/transactions/schema.js';
async function ensureSuperAdmin() {
    let admin = await User.findOne({ email: env.SUPERADMIN_EMAIL.toLowerCase() });
    if (!admin) {
        admin = await User.create({ name: env.SUPERADMIN_NAME, email: env.SUPERADMIN_EMAIL.toLowerCase(), isSuperAdmin: true, passwordHash: await bcrypt.hash(env.SUPERADMIN_PASSWORD, 12) });
        console.log(`✔ Super admin created: ${env.SUPERADMIN_EMAIL} / ${env.SUPERADMIN_PASSWORD}`);
    }
    else {
        console.log(`• Super admin already exists: ${admin.email}`);
    }
    return admin;
}
/** Business dates are stored as UTC midnight of the day, exactly like dates picked in the app. */
const daysAgo = (n) => new Date(new Date().setUTCHours(0, 0, 0, 0) - n * 86400000);
const DEMO_NAME = 'Karim Traders (Demo)';
async function seedDemo(superAdminId) {
    const name = DEMO_NAME;
    if (await Company.exists({ name })) {
        console.log(`• Demo company already exists: ${name}`);
        return;
    }
    const company = await Company.create({
        name, phone: '01711234567', email: 'accounts@karimtraders.example', address: 'House 12, Road 5, Dhanmondi', city: 'Dhaka', state: 'Dhaka', pincode: '1205',
        gstin: '004589127-0101', pan: '284716395021', businessType: 'Retail & Wholesale', businessCategory: 'Grocery & FMCG', createdBy: superAdminId,
        settings: {
            print: {
                bankDetails: 'Dutch-Bangla Bank, Dhanmondi Branch\nA/c No: 1051100012345\nRouting No: 090260434\nA/c Holder: Karim Traders',
                showPreviousBalance: true,
                termsAndConditions: 'Goods once sold will not be taken back.\nInterest @18% p.a. is charged on payments delayed beyond the due date.\nSubject to Dhaka jurisdiction.',
            },
        },
    });
    await bootstrapCompany(company._id);
    const c = company._id;
    const roles = await Role.find({ company: c }).lean();
    const role = (n) => roles.find((r) => r.name === n)._id;
    const hash = await bcrypt.hash('Demo@12345', 12);
    const adminUser = await User.create({ name: 'Abdul Karim', email: 'owner@demo.com', phone: '01711000001', company: c, role: role('Admin'), passwordHash: hash });
    const salesUser = await User.create({ name: 'Rima Akter', email: 'sales@demo.com', phone: '01711000002', company: c, role: role('Salesman'), passwordHash: hash });
    await User.create({ name: 'Jahangir Alam', email: 'accounts@demo.com', phone: '01711000003', company: c, role: role('Accountant'), passwordHash: hash });
    await User.create({ name: 'Shahid Hossain', email: 'stock@demo.com', phone: '01711000004', company: c, role: role('Stock Keeper'), passwordHash: hash });
    const ctx = {
        companyId: c, companyName: name, userId: adminUser._id, userName: adminUser.name, isSuperAdmin: false,
        settings: resolveSettings({}), perms: new Set(ALL_PERMISSIONS), approvalRequired: new Set(),
    };
    const bank = await BankAccount.create({ company: c, name: 'DBBL Current A/c', kind: 'bank', bankName: 'Dutch-Bangla Bank', accountNumber: '1051100012345', ifsc: '090260434', holderName: name, openingBalance: 150000, openingDate: daysAgo(370), printOnInvoice: true });
    await BankAccount.updateOne({ company: c, kind: 'cash' }, { $set: { openingBalance: 25000, openingDate: daysAgo(370) } });
    const wholesale = await PartyGroup.create({ company: c, name: 'Wholesale Buyers' });
    const retail = await PartyGroup.create({ company: c, name: 'Retail Customers' });
    const suppliers = await PartyGroup.create({ company: c, name: 'Suppliers' });
    const partyData = [
        { name: 'Rahman General Store', phone: '01822001100', email: 'rahman.store@example.com', group: wholesale._id, state: 'Dhaka', billingAddress: 'Shop 4, Mirpur Road, Mohammadpur, Dhaka', partyType: 'customer', openingBalance: 5000, creditLimit: 100000, gstin: '001234567-0101', gstType: 'regular' },
        { name: 'Haque Super Shop', phone: '01822002200', email: 'haque.shop@example.com', group: wholesale._id, state: 'Dhaka', billingAddress: 'Elephant Road, Dhaka', partyType: 'customer', openingBalance: 0, creditLimit: 200000 },
        { name: 'Ayesha Siddiqua', phone: '01822003300', group: retail._id, state: 'Dhaka', partyType: 'customer' },
        { name: 'Hotel Sea Pearl', phone: '01822004400', email: 'purchase@seapearl.example', group: wholesale._id, state: 'Chattogram', billingAddress: 'Agrabad C/A, Chattogram', partyType: 'customer', gstin: '002468135-0101', gstType: 'regular' },
        { name: 'Bhuiyan Distributors', phone: '01822005500', email: 'orders@bhuiyan.example', group: suppliers._id, state: 'Dhaka', partyType: 'supplier', openingBalance: -12000, gstin: '003456789-0101', gstType: 'regular' },
        { name: 'Golden Harvest Foods Ltd', phone: '01822006600', email: 'sales@goldenharvest.example', group: suppliers._id, state: 'Khulna', partyType: 'supplier', gstin: '005678912-0102', gstType: 'regular' },
        { name: 'Molla Traders', phone: '01822007700', group: wholesale._id, state: 'Dhaka', partyType: 'both', gstType: 'composition' },
        { name: 'Chowdhury Mart', phone: '01822008800', email: 'chowdhury.mart@example.com', group: wholesale._id, state: 'Sylhet', billingAddress: 'Zindabazar, Sylhet', partyType: 'customer', creditLimit: 150000, gstin: '006781234-0101', gstType: 'regular' },
        { name: 'Bismillah Store', phone: '01822009900', group: wholesale._id, state: 'Dhaka', billingAddress: 'Kaptan Bazar, Old Dhaka', partyType: 'customer', openingBalance: 3500, creditLimit: 60000 },
        { name: 'Shapla Departmental Store', phone: '01833001100', email: 'shapla.dept@example.com', group: wholesale._id, state: 'Dhaka', billingAddress: 'Sector 7, Uttara, Dhaka', partyType: 'customer', creditLimit: 150000, gstin: '007812345-0101', gstType: 'regular' },
        { name: 'Al-Madina Traders', phone: '01833002200', group: wholesale._id, state: 'Dhaka', billingAddress: 'Chashara, Narayanganj', partyType: 'customer', openingBalance: 7800, creditLimit: 80000 },
        { name: 'Rupsha Bazar', phone: '01833003300', email: 'rupsha.bazar@example.com', group: wholesale._id, state: 'Khulna', billingAddress: 'KDA Avenue, Khulna', partyType: 'customer', creditLimit: 100000, gstin: '008923456-0102', gstType: 'regular' },
        { name: 'Padma Grocery', phone: '01833004400', group: wholesale._id, state: 'Rajshahi', billingAddress: 'Shaheb Bazar, Rajshahi', partyType: 'customer', creditLimit: 70000 },
        { name: 'Meghna Super Store', phone: '01833005500', email: 'meghna.super@example.com', group: wholesale._id, state: 'Dhaka', billingAddress: 'Road 11, Banani, Dhaka', partyType: 'customer', creditLimit: 200000, gstin: '009134567-0101', gstType: 'regular' },
        { name: 'Cafe Dhanmondi', phone: '01833006600', email: 'hello@cafedhanmondi.example', group: wholesale._id, state: 'Dhaka', billingAddress: 'Road 27, Dhanmondi, Dhaka', partyType: 'customer', creditLimit: 50000 },
        { name: 'Green Valley School Canteen', phone: '01833007700', group: wholesale._id, state: 'Dhaka', billingAddress: 'Lalmatia, Dhaka', partyType: 'customer', creditLimit: 40000 },
        { name: 'Talukder Enterprise', phone: '01833008800', group: wholesale._id, state: 'Mymensingh', billingAddress: 'Ganginarpar, Mymensingh', partyType: 'customer', creditLimit: 90000, gstType: 'composition' },
        { name: 'Barishal Food Corner', phone: '01833009900', group: wholesale._id, state: 'Barishal', billingAddress: 'Sadar Road, Barishal', partyType: 'customer', creditLimit: 60000 },
        { name: 'Uttara Family Mart', phone: '01844001100', email: 'familymart.uttara@example.com', group: wholesale._id, state: 'Dhaka', billingAddress: 'Sector 4, Uttara, Dhaka', partyType: 'customer', creditLimit: 120000, gstin: '001357924-0101', gstType: 'regular' },
        { name: 'Sonar Bangla Restaurant', phone: '01844002200', group: wholesale._id, state: 'Dhaka', billingAddress: 'Satmasjid Road, Dhaka', partyType: 'customer', openingBalance: 2200, creditLimit: 50000 },
        { name: 'Kazi Brothers', phone: '01844003300', group: wholesale._id, state: 'Rangpur', billingAddress: 'Station Road, Rangpur', partyType: 'customer', creditLimit: 80000 },
        { name: 'Tanvir Ahmed', phone: '01844004400', group: retail._id, state: 'Dhaka', billingAddress: 'Flat 3B, Road 9A, Dhanmondi', partyType: 'customer' },
        { name: 'Farzana Haque', phone: '01844005500', email: 'farzana.h@example.com', group: retail._id, state: 'Dhaka', billingAddress: 'Jigatola, Dhaka', partyType: 'customer' },
        { name: 'Mahmudul Hasan', phone: '01844006600', group: retail._id, state: 'Dhaka', partyType: 'customer' },
        { name: 'Sharmin Akter', phone: '01844007700', group: retail._id, state: 'Dhaka', billingAddress: 'Kalabagan, Dhaka', partyType: 'customer' },
        { name: 'Nusrat Jahan', phone: '01844008800', group: retail._id, state: 'Dhaka', partyType: 'customer' },
        { name: 'Imran Hossain', phone: '01844009900', group: retail._id, state: 'Dhaka', billingAddress: 'Shankar, Dhanmondi', partyType: 'customer' },
        { name: 'Meghna Consumer Products', phone: '01855001100', email: 'trade@meghnaconsumer.example', group: suppliers._id, state: 'Dhaka', billingAddress: 'Tejgaon I/A, Dhaka', partyType: 'supplier', gstin: '002244668-0101', gstType: 'regular' },
        { name: 'Padma Agro Products Ltd', phone: '01855002200', email: 'orders@padmaagro.example', group: suppliers._id, state: 'Rajshahi', billingAddress: 'BSCIC Industrial Area, Rajshahi', partyType: 'supplier', gstin: '003355779-0103', gstType: 'regular' },
        { name: 'Sylhet Tea Estates Supply', phone: '01855003300', email: 'sales@sylhettea.example', group: suppliers._id, state: 'Sylhet', billingAddress: 'Airport Road, Sylhet', partyType: 'supplier', gstin: '004466880-0104', gstType: 'regular' },
        { name: 'Chattogram Spice House', phone: '01855004400', group: suppliers._id, state: 'Chattogram', billingAddress: 'Khatunganj, Chattogram', partyType: 'supplier', openingBalance: -4500 },
    ];
    const parties = await Party.insertMany(partyData.map((p) => ({ ...p, company: c, openingBalanceDate: daysAgo(370), createdBy: adminUser._id })));
    await recalcParties(c, parties.map((p) => p._id));
    const P = (n) => String(parties.find((p) => p.name === n)._id);
    const cats = await Category.insertMany(['Grocery', 'Beverages', 'Personal Care', 'Household'].map((n) => ({ company: c, name: n })));
    const cat = (n) => cats.find((x) => x.name === n)._id;
    const units = await Unit.find({ company: c }).lean();
    const unit = (s) => units.find((u) => u.shortName === s)._id;
    const itemData = [
        { name: 'Miniket Rice 5kg', category: cat('Grocery'), baseUnit: unit('BAG'), salePrice: 650, wholesalePrice: 620, minWholesaleQty: 10, purchasePrice: 540, taxRate: 5, openingQty: 60, openingPrice: 540, minStock: 15, hsn: '1006', location: 'Rack A1' },
        { name: 'Masoor Dal 1kg', category: cat('Grocery'), baseUnit: unit('PAC'), salePrice: 160, wholesalePrice: 150, minWholesaleQty: 20, purchasePrice: 128, taxRate: 0, openingQty: 120, openingPrice: 128, minStock: 30, hsn: '0713', location: 'Rack A2' },
        { name: 'Sunflower Oil 1L', category: cat('Grocery'), baseUnit: unit('BOX'), secondaryUnit: unit('BTL'), conversionRate: 12, salePrice: 1800, wholesalePrice: 1740, minWholesaleQty: 5, purchasePrice: 1560, taxRate: 5, openingQty: 25, openingPrice: 1560, minStock: 6, hsn: '1512', location: 'Rack B1' },
        { name: 'Sugar 1kg', category: cat('Grocery'), baseUnit: unit('PAC'), salePrice: 48, wholesalePrice: 45, minWholesaleQty: 50, purchasePrice: 41, taxRate: 0, openingQty: 300, openingPrice: 41, minStock: 50, hsn: '1701' },
        { name: 'Green Tea 100 Bags', category: cat('Beverages'), baseUnit: unit('BOX'), salePrice: 320, purchasePrice: 245, taxRate: 15, openingQty: 8, openingPrice: 245, minStock: 10, hsn: '0902' },
        { name: 'Cold Drink 2L', category: cat('Beverages'), baseUnit: unit('BTL'), salePrice: 95, wholesalePrice: 88, minWholesaleQty: 24, purchasePrice: 72, taxRate: 15, openingQty: 96, openingPrice: 72, minStock: 24, hsn: '2202' },
        { name: 'Bath Soap 125g', category: cat('Personal Care'), baseUnit: unit('PCS'), salePrice: 45, purchasePrice: 32, taxRate: 15, openingQty: 200, openingPrice: 32, minStock: 40, hsn: '3401' },
        { name: 'Shampoo 340ml', category: cat('Personal Care'), baseUnit: unit('BTL'), salePrice: 299, purchasePrice: 228, taxRate: 15, openingQty: 4, openingPrice: 228, minStock: 12, hsn: '3305' },
        { name: 'Detergent Powder 1kg', category: cat('Household'), baseUnit: unit('PAC'), salePrice: 135, purchasePrice: 104, taxRate: 15, openingQty: 80, openingPrice: 104, minStock: 20, hsn: '3402' },
        { name: 'Chinigura Rice 1kg', category: cat('Grocery'), baseUnit: unit('PAC'), salePrice: 180, wholesalePrice: 165, minWholesaleQty: 20, purchasePrice: 148, taxRate: 5, openingQty: 150, openingPrice: 148, minStock: 30, hsn: '1006', location: 'Rack A1' },
        { name: 'Atta 2kg', category: cat('Grocery'), baseUnit: unit('PAC'), salePrice: 130, wholesalePrice: 122, minWholesaleQty: 20, purchasePrice: 108, taxRate: 0, openingQty: 140, openingPrice: 108, minStock: 30, hsn: '1101', location: 'Rack A3' },
        { name: 'Salt 1kg', category: cat('Grocery'), baseUnit: unit('PAC'), salePrice: 42, wholesalePrice: 38, minWholesaleQty: 50, purchasePrice: 32, taxRate: 0, openingQty: 250, openingPrice: 32, minStock: 50, hsn: '2501' },
        { name: 'Chola Boot 1kg', category: cat('Grocery'), baseUnit: unit('PAC'), salePrice: 120, wholesalePrice: 110, minWholesaleQty: 20, purchasePrice: 96, taxRate: 0, openingQty: 90, openingPrice: 96, minStock: 20, hsn: '0713', location: 'Rack A2' },
        { name: 'Soybean Oil 5L', category: cat('Grocery'), baseUnit: unit('BTL'), salePrice: 920, wholesalePrice: 890, minWholesaleQty: 6, purchasePrice: 820, taxRate: 5, openingQty: 40, openingPrice: 820, minStock: 10, hsn: '1507', location: 'Rack B1' },
        { name: 'Red Chilli Powder 200g', category: cat('Grocery'), baseUnit: unit('PAC'), salePrice: 95, wholesalePrice: 85, minWholesaleQty: 24, purchasePrice: 70, taxRate: 5, openingQty: 100, openingPrice: 70, minStock: 24, hsn: '0904', location: 'Rack C1' },
        { name: 'Turmeric Powder 200g', category: cat('Grocery'), baseUnit: unit('PAC'), salePrice: 85, wholesalePrice: 75, minWholesaleQty: 24, purchasePrice: 62, taxRate: 5, openingQty: 100, openingPrice: 62, minStock: 24, hsn: '0910', location: 'Rack C1' },
        { name: 'Powder Milk 500g', category: cat('Grocery'), baseUnit: unit('PAC'), salePrice: 450, wholesalePrice: 430, minWholesaleQty: 12, purchasePrice: 385, taxRate: 5, openingQty: 48, openingPrice: 385, minStock: 12, hsn: '0402', location: 'Rack C2' },
        { name: 'Instant Noodles 8 Pack', category: cat('Grocery'), baseUnit: unit('PAC'), salePrice: 160, wholesalePrice: 150, minWholesaleQty: 24, purchasePrice: 128, taxRate: 15, openingQty: 120, openingPrice: 128, minStock: 30, hsn: '1902', location: 'Rack C3' },
        { name: 'Biscuits Family Pack', category: cat('Grocery'), baseUnit: unit('PAC'), salePrice: 120, wholesalePrice: 110, minWholesaleQty: 24, purchasePrice: 92, taxRate: 15, openingQty: 120, openingPrice: 92, minStock: 30, hsn: '1905', location: 'Rack C3' },
        { name: 'Black Tea 400g', category: cat('Beverages'), baseUnit: unit('PAC'), salePrice: 260, wholesalePrice: 240, minWholesaleQty: 12, purchasePrice: 205, taxRate: 15, openingQty: 60, openingPrice: 205, minStock: 15, hsn: '0902' },
        { name: 'Mineral Water 1.5L', category: cat('Beverages'), baseUnit: unit('BTL'), salePrice: 30, wholesalePrice: 27, minWholesaleQty: 24, purchasePrice: 20, taxRate: 15, openingQty: 240, openingPrice: 20, minStock: 48, hsn: '2201' },
        { name: 'Toothpaste 200g', category: cat('Personal Care'), baseUnit: unit('PCS'), salePrice: 145, purchasePrice: 112, taxRate: 15, openingQty: 80, openingPrice: 112, minStock: 20, hsn: '3306' },
        { name: 'Hand Wash 250ml', category: cat('Personal Care'), baseUnit: unit('BTL'), salePrice: 120, purchasePrice: 94, taxRate: 15, openingQty: 60, openingPrice: 94, minStock: 15, hsn: '3401' },
        { name: 'Dishwash Bar', category: cat('Household'), baseUnit: unit('PCS'), salePrice: 30, purchasePrice: 22, taxRate: 15, openingQty: 200, openingPrice: 22, minStock: 40, hsn: '3402' },
        { name: 'Floor Cleaner 1L', category: cat('Household'), baseUnit: unit('BTL'), salePrice: 210, purchasePrice: 162, taxRate: 15, openingQty: 40, openingPrice: 162, minStock: 10, hsn: '3808' },
        { name: 'Tissue Box', category: cat('Household'), baseUnit: unit('BOX'), salePrice: 110, purchasePrice: 82, taxRate: 15, openingQty: 80, openingPrice: 82, minStock: 20, hsn: '4818' },
        { name: 'Mosquito Coil 10pcs', category: cat('Household'), baseUnit: unit('BOX'), salePrice: 95, purchasePrice: 72, taxRate: 15, openingQty: 100, openingPrice: 72, minStock: 24, hsn: '3808' },
        { name: 'Home Delivery Charge', type: 'service', baseUnit: unit('NOS'), salePrice: 50, taxRate: 15, hsn: '9965' },
    ];
    let codeSeq = 0;
    const items = await Item.insertMany(itemData.map((i) => ({ ...i, company: c, code: `ITM${String(++codeSeq).padStart(5, '0')}`, openingDate: daysAgo(370), createdBy: adminUser._id })));
    await recalcItems(c, items.map((i) => i._id));
    const { Counter } = await import('../models/index.js');
    await Counter.updateOne({ company: c, key: 'ITEM_CODE' }, { $set: { seq: codeSeq } }, { upsert: true });
    const I = (n) => items.find((i) => i.name === n);
    const line = (n, qty, price, extra = {}) => {
        const it = I(n);
        return { item: String(it._id), name: it.name, qty, price: price ?? it.salePrice, taxRate: it.taxRate, unit: it.baseUnit ? String(it.baseUnit) : undefined, ...extra };
    };
    const pline = (n, qty) => {
        const it = I(n);
        return { item: String(it._id), name: it.name, qty, price: it.purchasePrice ?? 0, taxRate: it.taxRate, unit: it.baseUnit ? String(it.baseUnit) : undefined };
    };
    const tx = (body) => createTxn(ctx, txnBodySchema.parse(body));
    const fullTotal = (lines) => computeTotals(lines.map((l) => computeLine(l)), { roundOff: true }).total;
    const events = [];
    const on = (d, run, cash = 0) => void events.push({ daysAgo: d, run, cash });
    const ecat = async (n) => String((await ExpenseCategory.findOne({ company: c, name: n }).lean())._id);
    const [rent, power, freight, phoneBill, snacks, salary, office, petrol, repair, marketing, bankCharges, misc] = await Promise.all(['Rent', 'Electricity Bill', 'Transport & Freight', 'Telephone & Internet', 'Tea & Snacks', 'Salary', 'Office Supplies', 'Petrol', 'Repair & Maintenance', 'Marketing', 'Bank Charges', 'Miscellaneous'].map(ecat));
    const bankId = String(bank._id);
    const cashAccount = (await BankAccount.findOne({ company: c, kind: 'cash' }).lean());
    // The same numbers on every run
    let rndState = 20261026;
    const rnd = () => (rndState = (rndState * 48271) % 2147483647) / 2147483647;
    // Busier in the winter wedding season (Oct and Nov), quieter in the monsoon (Jul and Aug)
    const SEASON = [1, 0.95, 1.05, 1.1, 1.15, 0.95, 0.85, 0.85, 1.1, 1.35, 1.3, 1.05];
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const sample = (a, k) => {
        const copy = [...a];
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy.slice(0, k);
    };
    const STATE = Object.fromEntries(partyData.filter((p) => p.state !== 'Dhaka').map((p) => [p.name, p.state]));
    const goods = itemData.filter((i) => i.type !== 'service');
    const inCat = (...names) => goods.filter((i) => names.some((n) => String(cat(n)) === String(i.category))).map((i) => i.name);
    const ALL = goods.map((i) => i.name);
    const FOOD = inCat('Grocery', 'Beverages');
    const NON_FOOD = inCat('Personal Care', 'Household');
    // Who buys wholesale, how often (relative weight), how much (scale) and what
    const CUSTOMERS = [
        { party: 'Rahman General Store', weight: 5, scale: 1.2, likes: ALL },
        { party: 'Haque Super Shop', weight: 5, scale: 1.3, likes: ALL },
        { party: 'Hotel Sea Pearl', weight: 3, scale: 1.5, likes: FOOD },
        { party: 'Molla Traders', weight: 3, scale: 1, likes: ALL },
        { party: 'Chowdhury Mart', weight: 3, scale: 1.1, likes: ALL },
        { party: 'Bismillah Store', weight: 3, scale: 0.7, likes: ALL },
        { party: 'Shapla Departmental Store', weight: 4, scale: 1.2, likes: ALL },
        { party: 'Al-Madina Traders', weight: 2, scale: 1, likes: FOOD },
        { party: 'Rupsha Bazar', weight: 2, scale: 1.1, likes: ALL },
        { party: 'Padma Grocery', weight: 2, scale: 0.8, likes: FOOD },
        { party: 'Meghna Super Store', weight: 4, scale: 1.4, likes: ALL },
        { party: 'Cafe Dhanmondi', weight: 2, scale: 0.5, likes: ['Sugar 1kg', 'Black Tea 400g', 'Green Tea 100 Bags', 'Powder Milk 500g', 'Mineral Water 1.5L', 'Cold Drink 2L', 'Biscuits Family Pack', 'Tissue Box', 'Hand Wash 250ml'] },
        { party: 'Green Valley School Canteen', weight: 1, scale: 0.5, likes: ['Biscuits Family Pack', 'Instant Noodles 8 Pack', 'Mineral Water 1.5L', 'Cold Drink 2L', 'Sugar 1kg', 'Tissue Box'] },
        { party: 'Talukder Enterprise', weight: 2, scale: 1, likes: ALL },
        { party: 'Barishal Food Corner', weight: 1, scale: 0.8, likes: FOOD },
        { party: 'Uttara Family Mart', weight: 3, scale: 1, likes: ALL },
        { party: 'Sonar Bangla Restaurant', weight: 2, scale: 0.7, likes: ['Miniket Rice 5kg', 'Chinigura Rice 1kg', 'Soybean Oil 5L', 'Masoor Dal 1kg', 'Chola Boot 1kg', 'Salt 1kg', 'Red Chilli Powder 200g', 'Turmeric Powder 200g', 'Sugar 1kg', 'Mineral Water 1.5L', 'Dishwash Bar'] },
        { party: 'Kazi Brothers', weight: 1, scale: 1, likes: NON_FOOD.concat(FOOD.slice(0, 6)) },
    ];
    const RETAIL = ['Ayesha Siddiqua', 'Tanvir Ahmed', 'Farzana Haque', 'Mahmudul Hasan', 'Sharmin Akter', 'Nusrat Jahan', 'Imran Hossain'];
    const weighted = CUSTOMERS.flatMap((cu) => Array(cu.weight).fill(cu));
    // Kept out of the counter so the low stock warning still shows
    const LOW = ['Green Tea 100 Bags', 'Shampoo 340ml'];
    const SUPPLIER = {};
    for (const n of ['Miniket Rice 5kg', 'Masoor Dal 1kg', 'Sugar 1kg', 'Green Tea 100 Bags', 'Chinigura Rice 1kg', 'Atta 2kg', 'Salt 1kg', 'Chola Boot 1kg'])
        SUPPLIER[n] = 'Bhuiyan Distributors';
    for (const n of ['Sunflower Oil 1L', 'Soybean Oil 5L', 'Cold Drink 2L', 'Mineral Water 1.5L', 'Bath Soap 125g', 'Shampoo 340ml'])
        SUPPLIER[n] = 'Golden Harvest Foods Ltd';
    for (const n of ['Detergent Powder 1kg', 'Toothpaste 200g', 'Hand Wash 250ml', 'Dishwash Bar', 'Floor Cleaner 1L', 'Tissue Box', 'Mosquito Coil 10pcs'])
        SUPPLIER[n] = 'Meghna Consumer Products';
    for (const n of ['Powder Milk 500g', 'Instant Noodles 8 Pack', 'Biscuits Family Pack'])
        SUPPLIER[n] = 'Padma Agro Products Ltd';
    SUPPLIER['Black Tea 400g'] = 'Sylhet Tea Estates Supply';
    for (const n of ['Red Chilli Powder 200g', 'Turmeric Powder 200g'])
        SUPPLIER[n] = 'Chattogram Spice House';
    const SUPPLIER_STATE = { 'Golden Harvest Foods Ltd': 'Khulna', 'Padma Agro Products Ltd': 'Rajshahi', 'Sylhet Tea Estates Supply': 'Sylhet', 'Chattogram Spice House': 'Chattogram' };
    /** A wholesale line: about ৳6,000 worth scaled by the buyer and the season, at the wholesale rate when it applies */
    const bulkLine = (n, f) => {
        const it = I(n);
        const qty = Math.max(1, Math.round(Math.min(60, 6000 / it.salePrice) * f));
        return line(n, qty, it.wholesalePrice && qty >= (it.minWholesaleQty ?? Infinity) ? it.wholesalePrice : undefined);
    };
    const sales = [];
    for (let d = 363; d >= 1; d--) {
        const season = SEASON[daysAgo(d).getUTCMonth()];
        const friday = daysAgo(d).getUTCDay() === 5;
        // One to four wholesale invoices a day (fewer on Friday)
        const nWholesale = friday ? Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 3.2 * season);
        for (const cu of sample([...new Set(Array.from({ length: nWholesale * 2 }, () => pick(weighted)))], nWholesale)) {
            const f = cu.scale * season * (0.6 + 0.8 * rnd());
            const lines = sample(cu.likes, 3 + Math.floor(rnd() * 5)).map((n) => bulkLine(n, f));
            // Some invoices come from a quotation, an order or a challan raised a few days before
            const r = rnd();
            const via = r < 0.1 ? 'ESTIMATE' : r < 0.2 ? 'SALE_ORDER' : r < 0.23 ? 'PROFORMA' : r < 0.28 ? 'DELIVERY_CHALLAN' : undefined;
            const viaLag = via === 'DELIVERY_CHALLAN' ? 1 + Math.floor(rnd() * 3) : 2 + Math.floor(rnd() * 6);
            sales.push({ d, party: cu.party, lines, kind: 'wholesale', ...(via && d + viaLag <= 364 ? { via, viaLag } : {}) });
        }
        // A known retail customer now and then, often with home delivery
        if (rnd() < 0.3) {
            const lines = sample(ALL, 2 + Math.floor(rnd() * 3)).map((n) => line(n, 1 + Math.floor(rnd() * 3)));
            if (rnd() < 0.5)
                lines.push(line('Home Delivery Charge', 1));
            sales.push({ d, party: pick(RETAIL), lines, kind: 'retail' });
        }
        // Walk-in counter sales, settled in cash
        const nCounter = Math.round((1 + rnd() * 3) * season);
        for (let k = 0; k < nCounter; k++) {
            sales.push({ d, lines: sample(ALL.filter((n) => !LOW.includes(n)), 1 + Math.floor(rnd() * 4)).map((n) => line(n, 1 + Math.floor(rnd() * 3))), kind: 'counter' });
        }
    }
    // Every 15 days each supplier restocks what the next 15 days will sell (the last restock covers up to
    // yesterday). Half of the restocks start as a purchase order, a third are bought on credit and paid
    // about two weeks later, and now and then damaged goods go back to the supplier.
    for (let p = 364; p >= 4; p -= 15) {
        const sold = new Map();
        for (const s of sales)
            if (s.d <= p && (s.d > p - 15 || p - 15 < 4))
                for (const l of s.lines)
                    if (SUPPLIER[l.name])
                        sold.set(l.name, (sold.get(l.name) ?? 0) + l.qty);
        for (const supplier of [...new Set(Object.values(SUPPLIER))]) {
            const lines = [...sold].filter(([name]) => SUPPLIER[name] === supplier).map(([name, q]) => pline(name, q));
            if (!lines.length)
                continue;
            const state = SUPPLIER_STATE[supplier];
            const total = fullTotal(lines);
            const viaPO = rnd() < 0.5 && p + 4 <= 364;
            const credit = rnd() < 0.35;
            const doc = {};
            if (viaPO)
                on(p + 4, async () => (doc.po = await tx({ type: 'PURCHASE_ORDER', party: P(supplier), date: daysAgo(p + 4), dueDate: daysAgo(p), stateOfSupply: state, items: lines })));
            on(p, async () => (doc.bill = await tx({ type: 'PURCHASE', party: P(supplier), date: daysAgo(p), dueDate: daysAgo(p - 15), stateOfSupply: state, items: lines, settled: credit ? 0 : total, paymentAccount: bankId, sourceId: doc.po && String(doc.po._id) })));
            if (credit && p - 14 >= 1)
                on(p - 14, () => tx({ type: 'PAYMENT_OUT', party: P(supplier), date: daysAgo(p - 14), amount: total, paymentAccount: bankId, description: 'Bill payment by BEFTN' }));
            const back = lines.find((l) => !LOW.includes(l.name) && l.qty >= 10);
            if (back && rnd() < 0.15 && p - 2 >= 1) {
                on(p - 2, () => tx({ type: 'PURCHASE_RETURN', party: P(supplier), date: daysAgo(p - 2), stateOfSupply: state, sourceId: String(doc.bill._id), items: [{ ...back, qty: Math.max(1, Math.round(back.qty * 0.05)) }], settled: 0, description: pick(['Damaged in transit', 'Short expiry', 'Torn packets']) }));
            }
        }
    }
    const PAY_NOTES = ['By BEFTN', 'By bKash', 'By Nagad', 'Bank deposit', 'Cash received at shop', 'Cash collected by Rafiqul'];
    const payIn = (d, party, amount) => {
        const note = pick(PAY_NOTES);
        const cashIn = note.startsWith('Cash');
        on(d, () => tx({ type: 'PAYMENT_IN', party: P(party), date: daysAgo(d), amount, paymentAccount: cashIn ? undefined : bankId, description: note }), cashIn ? amount : 0);
    };
    sales.forEach((s) => {
        const total = fullTotal(s.lines);
        const state = s.party && STATE[s.party];
        if (s.via) {
            const extra = s.via === 'ESTIMATE' ? { terms: 'Valid for 15 days' } : s.via === 'PROFORMA' ? { terms: '50% advance to confirm the order. Balance on delivery.' } : s.via === 'SALE_ORDER' ? { dueDate: daysAgo(s.d) } : {};
            on(s.d + s.viaLag, async () => (s.src = await tx({ type: s.via, party: P(s.party), date: daysAgo(s.d + s.viaLag), stateOfSupply: state, items: s.lines, ...extra })));
        }
        // Counter and retail sales are paid at once. Wholesale: 40% paid on the spot, 40% on credit cleared
        // in one to four weeks, the rest half now and half later. Recent credit is still outstanding.
        let settled = total;
        let inCash = s.kind !== 'wholesale' || rnd() < 0.3;
        if (s.kind === 'wholesale') {
            const r = rnd();
            const lag = 7 + Math.floor(rnd() * 22);
            if (r >= 0.4) {
                settled = r < 0.8 ? 0 : Math.round(total / 200) * 100;
                inCash = settled > 0 && inCash;
                if (s.d - lag >= 1)
                    payIn(s.d - lag, s.party, total - settled);
            }
        }
        const body = {
            type: 'SALE', party: s.party && P(s.party), partyName: s.party ? undefined : 'Walk-in Customer', date: daysAgo(s.d), dueDate: daysAgo(s.d - 15), stateOfSupply: state, items: s.lines, settled,
            paymentAccount: inCash || !settled ? undefined : bankId,
        };
        on(s.d, async () => (s.doc = await tx({ ...body, sourceId: s.src && String(s.src._id) })), inCash ? settled : 0);
        // About one wholesale invoice in thirty has something sent back
        if (s.kind === 'wholesale' && settled === 0 && s.d > 3 && rnd() < 0.035) {
            const l = s.lines[0];
            on(s.d - 2, () => tx({ type: 'SALE_RETURN', party: P(s.party), date: daysAgo(s.d - 2), stateOfSupply: state, sourceId: String(s.doc._id), items: [{ ...l, qty: Math.max(1, Math.round(l.qty * 0.1)) }], settled: 0, description: pick(['Damaged packets', 'Wrong item delivered', 'Expired stock returned', 'Leaking bottles']) }));
        }
    });
    // Quotations that did not turn into business: older ones are cancelled, the last fortnight's are still open
    for (let d = 358; d >= 1; d -= 6 + Math.floor(rnd() * 6)) {
        const cu = pick(CUSTOMERS);
        const type = rnd() < 0.75 ? 'ESTIMATE' : 'PROFORMA';
        const items = sample(cu.likes, 2 + Math.floor(rnd() * 4)).map((n) => bulkLine(n, cu.scale * 1.5));
        on(d, async () => {
            const q = await tx({ type, party: P(cu.party), date: daysAgo(d), stateOfSupply: STATE[cu.party], items, terms: 'Valid for 15 days' });
            if (d > 15)
                await cancelTxn(ctx, q._id, pick(['Customer went with another supplier', 'Price not accepted', 'Order postponed']));
        });
    }
    // Open orders waiting to be delivered
    for (const [d, party] of [[6, 'Meghna Super Store'], [4, 'Shapla Departmental Store'], [3, 'Chowdhury Mart'], [2, 'Uttara Family Mart']]) {
        const cu = CUSTOMERS.find((x) => x.party === party);
        const items = sample(cu.likes, 4).map((n) => bulkLine(n, cu.scale));
        on(d, () => tx({ type: 'SALE_ORDER', party: P(party), date: daysAgo(d), dueDate: daysAgo(d - 5), stateOfSupply: STATE[party], items }));
    }
    on(2, () => tx({ type: 'PURCHASE_ORDER', party: P('Padma Agro Products Ltd'), date: daysAgo(2), dueDate: daysAgo(-5), stateOfSupply: 'Rajshahi', items: [pline('Powder Milk 500g', 48), pline('Biscuits Family Pack', 120), pline('Instant Noodles 8 Pack', 96)] }));
    // Bills on fixed days of every calendar month (rent at the month end); d is days ago
    const everyMonth = (dayOfMonth, add) => {
        const now = daysAgo(0);
        for (let m = 12; m >= 0; m--) {
            const at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, dayOfMonth);
            const d = Math.round((now.getTime() - at) / 86400000);
            if (d >= 0 && d <= 364)
                add(d, new Date(at).getUTCMonth());
        }
    };
    const expense = (d, category, name, qty, price, fromBank = false) => on(d, () => tx({ type: 'EXPENSE', expenseCategory: category, date: daysAgo(d), items: [{ name, qty, price }], settled: qty * price, paymentAccount: fromBank ? bankId : undefined }), fromBank ? 0 : -qty * price);
    everyMonth(5, (d) => expense(d, phoneBill, 'Broadband and mobile', 1, 999, true));
    everyMonth(10, (d) => expense(d, freight, 'Tempo hire', 1 + Math.round(rnd()), 900));
    everyMonth(12, (d, month) => expense(d, power, 'DESCO electricity bill', 1, Math.round((month >= 3 && month <= 5 ? 4100 : 2900) + 600 * rnd())));
    everyMonth(15, (d) => expense(d, snacks, 'Tea and snacks for staff', 1, 500 + 50 * Math.round(8 * rnd())));
    everyMonth(24, (d) => expense(d, freight, 'Tempo hire', 1 + Math.round(rnd()), 900));
    everyMonth(28, (d) => expense(d, rent, 'Shop rent', 1, 18000, true));
    everyMonth(28, (d) => expense(d, rent, 'Godown rent, Lalbagh', 1, 9500, true));
    // Salaries for the month just ended, paid from the bank on the 1st (staff join dates as in HR below)
    everyMonth(1, (d) => {
        const staff = [['Rima Akter', 19000, 400], ['Rafiqul Islam', 650 * 26, 200], ['Nasrin Sultana', 14500, 150]];
        const lines = staff.filter(([, , joined]) => d < joined - 30).map(([n, amt]) => ({ name: `Salary: ${n}`, qty: 1, price: amt }));
        if (lines.length)
            on(d, () => tx({ type: 'EXPENSE', expenseCategory: salary, date: daysAgo(d), items: lines, settled: lines.reduce((a, l) => a + l.price, 0), paymentAccount: bankId }));
    });
    everyMonth(20, (d) => expense(d, office, pick(['Printer paper and pens', 'Receipt rolls', 'Cash memo books', 'Packing tape and polybags']), 1, 400 + 50 * Math.round(10 * rnd())));
    for (let d = 362; d >= 1; d -= 6 + Math.floor(rnd() * 4))
        expense(d, petrol, 'Fuel for delivery van', 1, 1200 + 100 * Math.round(8 * rnd()));
    for (let d = 350; d >= 1; d -= 35 + Math.floor(rnd() * 25))
        expense(d, repair, pick(['Freezer servicing', 'Van tyre change', 'Shutter repair', 'Weighing scale calibration', 'Electrical wiring fix']), 1, 800 + 100 * Math.round(25 * rnd()));
    for (let d = 340; d >= 1; d -= 60 + Math.floor(rnd() * 30))
        expense(d, marketing, pick(['Facebook page boost', 'Leaflet printing', 'Shop banner', 'Festival offer posters']), 1, 2000 + 500 * Math.round(6 * rnd()), true);
    everyMonth(30, (d) => expense(d, bankCharges, 'Account maintenance and SMS charges', 1, 230, true));
    everyMonth(18, (d) => expense(d, misc, pick(['Cleaning supplies', 'Mosque donation', 'Guard tips', 'Courier charges']), 1, 300 + 50 * Math.round(8 * rnd())));
    // A ৳2 lakh business loan taken about ten months ago into the bank, repaid by EMI from the bank on the 5th
    const loanStart = 300;
    const loan = await LoanAccount.create({
        company: c, name: 'DBBL SME Loan', lender: 'Dutch-Bangla Bank', accountNumber: 'LN88120456', interestRate: 10.5, termMonths: 24, openingBalance: 200000, openingDate: daysAgo(loanStart),
        receivedIn: bank._id, processingFee: 2000, feePaidFrom: bank._id, description: 'Working capital for festival stock', createdBy: adminUser._id,
    });
    const monthlyRate = 10.5 / 1200;
    const emi = Math.round((200000 * monthlyRate) / (1 - (1 + monthlyRate) ** -24));
    let owed = 200000;
    everyMonth(5, (d) => {
        if (d <= 0 || d > loanStart - 20)
            return;
        on(d, async () => {
            const interest = Math.round(owed * monthlyRate);
            owed -= emi - interest;
            await LoanEntry.create({ company: c, loan: loan._id, kind: 'payment', principal: emi - interest, interest, amount: emi, account: bank._id, date: daysAgo(d), createdBy: adminUser._id });
        });
    });
    // The last six weeks, by hand
    const story = {};
    on(40, () => tx({ type: 'PURCHASE', party: P('Bhuiyan Distributors'), date: daysAgo(40), items: [pline('Miniket Rice 5kg', 40), pline('Masoor Dal 1kg', 100)], settled: 20000, paymentAccount: bankId }));
    on(35, async () => (story.s1 = await tx({ type: 'SALE', party: P('Rahman General Store'), date: daysAgo(35), dueDate: daysAgo(20), items: [line('Miniket Rice 5kg', 10, 620), line('Masoor Dal 1kg', 20, 150), line('Sugar 1kg', 50, 45)], settled: 5000 })), 5000);
    on(30, () => tx({ type: 'SALE_RETURN', party: P('Rahman General Store'), date: daysAgo(30), sourceId: String(story.s1._id), items: [line('Masoor Dal 1kg', 2, 150)], settled: 0, description: 'Damaged packets' }));
    on(28, () => tx({ type: 'SALE', party: P('Haque Super Shop'), date: daysAgo(28), dueDate: daysAgo(13), items: [line('Sunflower Oil 1L', 5, 1740), line('Cold Drink 2L', 48, 88)], settled: 0 }));
    on(25, () => tx({ type: 'PURCHASE', party: P('Golden Harvest Foods Ltd'), date: daysAgo(25), stateOfSupply: 'Khulna', items: [pline('Sunflower Oil 1L', 20), pline('Cold Drink 2L', 120)], settled: 0, dueDate: daysAgo(-5) }));
    on(15, () => tx({ type: 'PAYMENT_IN', party: P('Rahman General Store'), date: daysAgo(15), amount: 8000, description: 'Part payment by bKash', paymentAccount: bankId }));
    const anitaLines = [line('Bath Soap 125g', 6), line('Shampoo 340ml', 2), line('Home Delivery Charge', 1)];
    on(12, () => tx({ type: 'SALE', party: P('Ayesha Siddiqua'), date: daysAgo(12), items: anitaLines, settled: fullTotal(anitaLines) }), fullTotal(anitaLines));
    on(10, () => tx({ type: 'PAYMENT_OUT', party: P('Bhuiyan Distributors'), date: daysAgo(10), amount: 15000, paymentAccount: bankId }));
    on(6, async () => (story.s4 = await tx({ type: 'SALE', party: P('Hotel Sea Pearl'), date: daysAgo(6), dueDate: daysAgo(-9), stateOfSupply: 'Chattogram', items: [line('Miniket Rice 5kg', 15, 620), line('Sunflower Oil 1L', 3, 1740), line('Green Tea 100 Bags', 4)], settled: 0 })));
    // Cheques: Haque Super Shop's was deposited two days after it came in; Rahman General Store's is still to be
    // deposited, and the one issued to Golden Harvest has not cleared yet
    on(9, async () => (story.cheque = await tx({ type: 'PAYMENT_IN', party: P('Haque Super Shop'), date: daysAgo(9), amount: 5000, paymentMode: 'cheque', paymentRef: '552018', description: 'Part payment by cheque' })));
    on(7, () => closeCheque(ctx, story.cheque._id, { account: bankId, date: daysAgo(7) }));
    on(5, () => tx({ type: 'PROFORMA', party: P('Hotel Sea Pearl'), date: daysAgo(5), stateOfSupply: 'Chattogram', items: [line('Miniket Rice 5kg', 25, 615), line('Sunflower Oil 1L', 4, 1740)], terms: '50% advance to confirm the order. Balance on delivery.' }));
    on(4, () => tx({ type: 'ESTIMATE', party: P('Haque Super Shop'), date: daysAgo(4), items: [line('Miniket Rice 5kg', 20, 615), line('Masoor Dal 1kg', 50, 148)], terms: 'Valid for 15 days' }));
    on(3, () => tx({ type: 'PAYMENT_IN', party: P('Rahman General Store'), date: daysAgo(3), amount: 6000, paymentMode: 'cheque', paymentRef: '004512', description: 'Cheque handed over at the shop' }));
    on(2, () => tx({ type: 'PAYMENT_OUT', party: P('Golden Harvest Foods Ltd'), date: daysAgo(2), amount: 10000, paymentMode: 'cheque', paymentRef: '117730' }));
    on(3, () => tx({ type: 'PURCHASE_ORDER', party: P('Bhuiyan Distributors'), date: daysAgo(3), dueDate: daysAgo(-7), items: [pline('Sugar 1kg', 200), pline('Green Tea 100 Bags', 20)] }));
    on(2, () => tx({ type: 'SALE', party: P('Molla Traders'), date: daysAgo(2), items: [line('Detergent Powder 1kg', 24), line('Bath Soap 125g', 48, 42)], settled: 2000, paymentAccount: bankId }));
    on(1, () => tx({ type: 'SALE_ORDER', party: P('Hotel Sea Pearl'), date: daysAgo(1), dueDate: daysAgo(-3), stateOfSupply: 'Chattogram', items: [line('Cold Drink 2L', 48, 88), line('Sugar 1kg', 25)] }));
    on(1, () => tx({ type: 'DELIVERY_CHALLAN', party: P('Rahman General Store'), date: daysAgo(1), items: [line('Detergent Powder 1kg', 10), line('Bath Soap 125g', 24)] }));
    const walkIn = [line('Cold Drink 2L', 2), line('Sugar 1kg', 3)];
    on(0, () => tx({ type: 'SALE', partyName: 'Walk-in Customer', date: daysAgo(0), items: walkIn, settled: fullTotal(walkIn) }), fullTotal(walkIn));
    // Oldest first; same-day events keep the order above (purchases before sales). Cash above a float of
    // ৳20,000 is deposited at the end of every week.
    events.sort((a, b) => b.daysAgo - a.daysAgo);
    let cash = cashAccount.openingBalance ?? 0;
    let depositDay = 361;
    for (const e of events) {
        for (; depositDay > e.daysAgo; depositDay -= 7) {
            const amount = Math.floor((cash - 20000) / 1000) * 1000;
            if (amount <= 0)
                continue;
            cash -= amount;
            await BankEntry.create({ company: c, kind: 'transfer', account: cashAccount._id, toAccount: bank._id, amount, date: daysAgo(depositDay), description: 'Cash deposited in bank', createdBy: adminUser._id });
        }
        cash += e.cash ?? 0;
        await e.run();
    }
    // Everything above was saved just now. Give each document, and its activity log entries, the time of
    // day it would have been entered, so lists and the activity log read like a real year.
    const saved = await Transaction.find({ company: c }).sort({ createdAt: 1, _id: 1 }).select('date').lean();
    const perDay = new Map();
    const stamps = saved.map((t, i) => {
        const day = new Date(t.date).getTime();
        const n = perDay.get(day) ?? 0;
        perDay.set(day, n + 1);
        return { _id: t._id, at: new Date(Math.min(day + (270 + 37 * n) * 60000, Date.now() - (saved.length - i) * 1000)) };
    });
    await Transaction.collection.bulkWrite(stamps.map((s) => ({ updateOne: { filter: { _id: s._id }, update: { $set: { createdAt: s.at, updatedAt: s.at } } } })));
    await AuditLog.collection.bulkWrite(stamps.map((s) => ({ updateMany: { filter: { entityId: s._id }, update: { $set: { createdAt: s.at } } } })));
    const s4 = story.s4;
    // HR
    const e1 = await Employee.create({ company: c, code: 'EMP0001', name: 'Rima Akter', phone: '01711000002', designation: 'Sales Executive', department: 'Sales', salary: 18000, allowances: 1000, user: salesUser._id, joinDate: daysAgo(400) });
    await User.updateOne({ _id: salesUser._id }, { $set: { employee: e1._id } });
    const e2 = await Employee.create({ company: c, code: 'EMP0002', name: 'Rafiqul Islam', phone: '01711000010', designation: 'Delivery Boy', department: 'Logistics', salaryType: 'daily', salary: 650, joinDate: daysAgo(200) });
    const e3 = await Employee.create({ company: c, code: 'EMP0003', name: 'Nasrin Sultana', phone: '01711000011', designation: 'Cashier', department: 'Accounts', salary: 15000, deductions: 500, bankName: 'Dutch-Bangla Bank', accountNumber: '1051100023456', ifsc: '090260434', joinDate: daysAgo(150) });
    await Counter.updateOne({ company: c, key: 'EMPLOYEE_CODE' }, { $set: { seq: 3 } }, { upsert: true });
    // Attendance from the 1st of last month up to yesterday (Sunday is the weekly off)
    const ops = [];
    const today0 = daysAgo(0);
    for (let d = new Date(Date.UTC(today0.getUTCFullYear(), today0.getUTCMonth() - 1, 1)); d < today0; d.setUTCDate(d.getUTCDate() + 1)) {
        if (d.getUTCDay() === 0)
            continue;
        const day = d.toISOString().slice(0, 10);
        const n = d.getUTCDate();
        ops.push({ company: c, employee: e1._id, day, status: n % 11 === 0 ? 'half_day' : 'present', checkIn: '09:30', checkOut: n % 11 === 0 ? '13:30' : '18:30' });
        ops.push({ company: c, employee: e2._id, day, status: n % 9 === 0 ? 'absent' : 'present', checkIn: '09:00', checkOut: '19:00' });
        ops.push({ company: c, employee: e3._id, day, status: n === 14 || n === 15 ? 'leave' : n % 13 === 0 ? 'half_day' : 'present', checkIn: '10:00', checkOut: '18:00', note: n === 14 || n === 15 ? 'Family function' : undefined });
    }
    await Attendance.insertMany(ops);
    // Requests waiting in the approval queue
    const ymd = (dt) => dt.toISOString().slice(0, 10);
    const leaveFrom = ymd(daysAgo(-5));
    const leaveTo = ymd(daysAgo(-6));
    const leave = await HrRequest.create({ company: c, employee: e3._id, kind: 'leave', fromDate: leaveFrom, toDate: leaveTo, reason: "Sister's wedding", requestedBy: adminUser._id });
    await ApprovalRequest.create({ company: c, kind: 'hr_request', entity: 'HrRequest', entityId: leave._id, label: hrRequestLabel({ kind: 'leave', fromDate: leaveFrom, toDate: leaveTo }, e3.name), payload: { kind: 'leave', fromDate: leaveFrom, toDate: leaveTo, reason: "Sister's wedding" }, reason: "Sister's wedding", requestedBy: adminUser._id });
    const advance = await HrRequest.create({ company: c, employee: e1._id, kind: 'salary_advance', amount: 3000, reason: 'Medical expenses', requestedBy: salesUser._id });
    await ApprovalRequest.create({ company: c, kind: 'hr_request', entity: 'HrRequest', entityId: advance._id, label: hrRequestLabel({ kind: 'salary_advance', amount: 3000 }, e1.name), payload: { kind: 'salary_advance', amount: 3000, reason: 'Medical expenses' }, reason: 'Medical expenses', requestedBy: salesUser._id });
    const approvedAdvance = await HrRequest.create({ company: c, employee: e2._id, kind: 'salary_advance', amount: 2000, reason: 'Bike repair', status: 'approved', requestedBy: adminUser._id, reviewedBy: adminUser._id, reviewedAt: daysAgo(1) });
    await ApprovalRequest.create({ company: c, kind: 'hr_request', entity: 'HrRequest', entityId: approvedAdvance._id, label: hrRequestLabel({ kind: 'salary_advance', amount: 2000 }, e2.name), payload: { kind: 'salary_advance', amount: 2000 }, requestedBy: adminUser._id, status: 'approved', reviewedBy: adminUser._id, reviewedAt: daysAgo(1) });
    // What the bell shows: two requests waiting for approval and the low stock warning
    await notifyPermission(c, ['approvals.manage'], { type: 'approval', title: 'Approval needed', message: `${salesUser.name} requested: ${hrRequestLabel({ kind: 'salary_advance', amount: 3000 }, e1.name)}`, link: '/approvals' }, salesUser._id);
    await notifyPermission(c, ['approvals.manage'], { type: 'approval', title: 'Approval needed', message: `${adminUser.name} requested: ${hrRequestLabel({ kind: 'leave', fromDate: leaveFrom, toDate: leaveTo }, e3.name)}`, link: '/approvals' }, adminUser._id);
    await lowStockAlert(c);
    // A small mailbox so the email screens have something to show before SMTP / IMAP are connected
    const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
    const csv = 'Item,Unit,Old price,New price\nSunflower Oil 1L,Box of 12,1560,1595\nCold Drink 2L,Bottle,72,74\nGreen Tea 100 Bags,Box,245,245\n';
    const rel = path.join(String(c), 'email', String(new Date().getFullYear()), String(new Date().getMonth() + 1).padStart(2, '0'), 'demo-price-list-october.csv');
    await fs.promises.mkdir(path.dirname(path.join(env.storageDir, rel)), { recursive: true });
    await fs.promises.writeFile(path.join(env.storageDir, rel), csv);
    const priceList = await FileAsset.create({ company: c, originalName: 'price-list-october.csv', mime: 'text/csv', size: Buffer.byteLength(csv), path: rel, context: 'email' });
    const orderHtml = '<p>Dear Karim bhai,</p><p>Please arrange the following for delivery by <b>Monday morning</b>:</p>' +
        '<table style="border-collapse:collapse"><tr><th style="text-align:left;padding:4px 12px;border-bottom:1px solid #ddd">Item</th><th style="text-align:right;padding:4px 12px;border-bottom:1px solid #ddd">Qty</th></tr>' +
        '<tr><td style="padding:4px 12px">Miniket Rice 5kg</td><td style="text-align:right;padding:4px 12px">20 bags</td></tr>' +
        '<tr><td style="padding:4px 12px">Sunflower Oil 1L</td><td style="text-align:right;padding:4px 12px">4 boxes</td></tr>' +
        '<tr><td style="padding:4px 12px">Cold Drink 2L</td><td style="text-align:right;padding:4px 12px">48 bottles</td></tr></table>' +
        '<p>Kindly send the invoice by email as usual.</p><p>Regards,<br>Purchase Department<br>Hotel Sea Pearl</p>' +
        '<img src="https://mail.seapearl.example/open.gif" width="1" height="1" alt="">';
    const invoiceHtml = `<div style="font-family:Arial,sans-serif"><p>Dear Hotel Sea Pearl,</p><p>Please find invoice <b>${s4.number}</b> for ৳${s4.total.toLocaleString('en-IN')}.</p><p>Thank you for your business.<br>${name}</p></div>`;
    const reminderHtml = '<div style="font-family:Arial,sans-serif"><p>Dear Haque Super Shop,</p><p>This is a friendly reminder that your invoice is past its due date. Please arrange the payment at the earliest. Ignore this message if already paid.</p><p>Regards,<br>Karim Traders</p></div>';
    const from = `"${name}" <accounts@karimtraders.example>`;
    await EmailMessage.insertMany([
        { company: c, folder: 'inbox', from: '"Golden Harvest Foods Ltd" <sales@goldenharvest.example>', to: ['accounts@karimtraders.example'], subject: 'Revised price list for October', text: 'Dear Sir,\n\nPlease find attached our revised price list, effective from the 1st. Oil prices are up by about 2%, everything else is unchanged.\n\nRegards,\nSales Team, Golden Harvest Foods', date: hoursAgo(3), status: 'received', read: false, attachments: [{ name: 'price-list-october.csv', file: priceList._id, size: priceList.size }] },
        { company: c, folder: 'inbox', from: '"Hotel Sea Pearl" <purchase@seapearl.example>', to: ['accounts@karimtraders.example'], subject: 'Order for next week: rice, oil and cold drinks', html: orderHtml, text: htmlToText(orderHtml), date: hoursAgo(26), status: 'received', read: false, attachments: [] },
        { company: c, folder: 'inbox', from: '"Bhuiyan Distributors" <orders@bhuiyan.example>', to: ['accounts@karimtraders.example'], subject: 'Statement of account', text: 'Hello,\n\nAs per our books, ৳12,000 is outstanding from your side as on date. Kindly check and confirm.\nDetails: https://bhuiyan.example/statements\n\nThanks,\nAccounts, Bhuiyan Distributors', date: daysAgo(9), status: 'received', read: true, attachments: [] },
        { company: c, folder: 'inbox', from: '"Rahman General Store" <rahman.store@example.com>', to: ['accounts@karimtraders.example'], subject: 'Paid ৳8,000 by bKash', text: 'Assalamu Alaikum Karim bhai,\n\nI have sent ৳8,000 by bKash today against the pending bill. Please confirm once received.\n\nMizanur Rahman', date: daysAgo(15), status: 'received', read: true, attachments: [] },
        { company: c, folder: 'sent', from, to: ['purchase@seapearl.example'], subject: `Sale Invoice ${s4.number} from ${name}`, html: invoiceHtml, text: htmlToText(invoiceHtml), date: daysAgo(6), status: 'sent', read: true, related: s4._id, automation: 'auto_send_invoice', attachments: [] },
        { company: c, folder: 'sent', from, to: ['haque.shop@example.com'], subject: 'Payment reminder: invoice overdue', html: reminderHtml, text: htmlToText(reminderHtml), date: daysAgo(2), status: 'sent', read: true, automation: 'payment_reminder', attachments: [] },
        { company: c, folder: 'sent', from, to: ['orders@bhuiyan.example'], subject: 'Purchase order for sugar and green tea', text: 'Dear Sir,\n\nPlease supply 200 packs of Sugar 1kg and 20 boxes of Green Tea 100 Bags by next week.\n\nRegards,\nAbdul Karim', date: daysAgo(3), status: 'failed', error: 'Invalid login: 535 Authentication failed (demo)', read: true, sentBy: adminUser._id, attachments: [] },
    ]);
    console.log(`✔ Demo company created: ${name}`);
    console.log('  Logins (password Demo@12345): owner@demo.com (Admin), sales@demo.com (Salesman), accounts@demo.com (Accountant), stock@demo.com (Stock Keeper)');
}
/** Deletes the demo company with every record and uploaded file that belongs to it. */
async function resetDemo() {
    // The older India-based demo is removed too, so a reset after upgrading leaves a single demo company
    const companies = await Company.find({ name: { $in: [DEMO_NAME, 'Sharma Traders (Demo)'] } }).lean();
    if (!companies.length)
        return console.log('• No demo company to reset');
    const db = mongoose.connection.db;
    for (const company of companies) {
        for (const col of await db.collections()) {
            if (col.collectionName === 'companies')
                continue;
            await col.deleteMany({ company: company._id });
        }
        await Company.deleteOne({ _id: company._id });
        await fs.promises.rm(path.join(env.storageDir, String(company._id)), { recursive: true, force: true });
        console.log(`✔ Demo company removed: ${company.name}`);
    }
}
async function main() {
    await connectDB();
    const admin = await ensureSuperAdmin();
    if (process.argv.includes('--reset'))
        await resetDemo();
    if (process.argv.includes('--demo'))
        await seedDemo(admin._id);
    await disconnectDB();
}
main().catch(async (err) => {
    console.error(err);
    await disconnectDB();
    process.exit(1);
});
//# sourceMappingURL=seed.js.map
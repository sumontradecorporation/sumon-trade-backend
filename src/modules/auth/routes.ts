import crypto from 'node:crypto';
import { Router, type CookieOptions, type RequestHandler, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError } from '../../core/errors.js';
import { ok } from '../../core/http.js';
import { resolveSettings, redactSettings } from '../../core/settings.js';
import { ACCESS_COOKIE, REFRESH_COOKIE, authenticate, loadAuthUser } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { Company, RefreshToken, User } from '../../models/index.js';
import { audit } from '../../services/audit.js';

const router = Router();

const loginLimiter = (rateLimit as unknown as (options?: Record<string, unknown>) => RequestHandler)({
  windowMs: 15 * 60 * 1000,
  limit: env.NODE_ENV === 'production' ? 20 : 1000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many login attempts. Try again in 15 minutes.' } },
});

const cookieBase = (): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: env.COOKIE_SECURE,
  domain: env.COOKIE_DOMAIN || undefined,
  path: '/',
});

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

async function issueTokens(res: Response, userId: string, meta: { ip?: string; ua?: string }) {
  const access = jwt.sign({ sub: userId }, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'] });
  const refresh = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000);
  await RefreshToken.create({ user: userId, tokenHash: hash(refresh), expiresAt, ip: meta.ip, userAgent: meta.ua });
  res.cookie(ACCESS_COOKIE, access, { ...cookieBase(), maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000 });
  res.cookie(REFRESH_COOKIE, refresh, { ...cookieBase(), path: '/api/v1/auth', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000 });
  return { accessToken: access };
}

function clearTokens(res: Response) {
  res.clearCookie(ACCESS_COOKIE, cookieBase());
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase(), path: '/api/v1/auth' });
}

/** Session payload used by the frontend to decide where to go and what to show. */
async function sessionPayload(userId: string) {
  const user = await loadAuthUser(userId);
  if (!user) throw AppError.unauthorized();
  const company = user.company ? await Company.findById(user.company).select('name phone email logo isActive settings').lean() : null;
  return {
    user: { _id: user._id, name: user.name, email: user.email, phone: user.phone, isSuperAdmin: user.isSuperAdmin, company: user.company, role: user.role ? { _id: user.role._id, name: user.role.name } : null },
    permissions: user.permissions,
    approvalRequired: user.approvalRequired,
    company: company ? { ...company, settings: redactSettings(resolveSettings(company.settings)) } : null,
    home: user.isSuperAdmin ? '/companies' : `/c/${user.company}/dashboard`,
  };
}

const loginSchema = z.object({
  identifier: z.string().trim().min(3, 'Enter your email or phone'),
  password: z.string().min(1, 'Enter your password'),
});

router.post('/login', loginLimiter, validate(loginSchema), async (req, res) => {
  const { identifier, password } = req.body as z.infer<typeof loginSchema>;
  const id = identifier.toLowerCase();
  const user = await User.findOne({ $or: [{ email: id }, { phone: identifier }] }).select('+passwordHash');
  // Same message for unknown user and wrong password – avoids account enumeration.
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw new AppError(401, 'Invalid email/phone or password', 'INVALID_CREDENTIALS');
  if (user.status !== 'active') throw AppError.forbidden('Your account is deactivated. Contact your administrator.');
  if (!user.isSuperAdmin) {
    if (!user.company) throw AppError.forbidden('Your account is not linked to any company');
    const company = await Company.findById(user.company).select('isActive').lean();
    if (!company?.isActive) throw AppError.forbidden('Your company account is archived. Contact the administrator.');
  }
  user.lastLoginAt = new Date();
  await user.save();
  await issueTokens(res, String(user._id), { ip: req.ip, ua: req.header('user-agent') });
  await audit({ companyId: user.company ?? undefined, userId: user._id, userName: user.name, ip: req.ip, ua: req.header('user-agent') }, 'login', 'User', user._id, `${user.name} signed in`);
  ok(res, await sessionPayload(String(user._id)));
});

router.post('/refresh', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) throw AppError.unauthorized('No refresh token');
  const stored = await RefreshToken.findOne({ tokenHash: hash(token) });
  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    // Possible token reuse – revoke the whole family for safety.
    if (stored?.revokedAt) await RefreshToken.updateMany({ user: stored.user, revokedAt: null }, { $set: { revokedAt: new Date() } });
    clearTokens(res);
    throw AppError.unauthorized('Session expired. Please sign in again.');
  }
  const user = await loadAuthUser(String(stored.user));
  if (!user) {
    clearTokens(res);
    throw AppError.unauthorized('Account is inactive');
  }
  stored.revokedAt = new Date();
  await stored.save();
  await issueTokens(res, String(user._id), { ip: req.ip, ua: req.header('user-agent') });
  ok(res, await sessionPayload(String(user._id)));
});

router.post('/logout', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (token) await RefreshToken.updateOne({ tokenHash: hash(token) }, { $set: { revokedAt: new Date() } });
  clearTokens(res);
  ok(res, { loggedOut: true });
});

router.get('/me', authenticate, async (req, res) => {
  ok(res, await sessionPayload(String(req.user!._id)));
});

const profileSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.union([z.string().trim().toLowerCase().email(), z.literal('')]).optional(),
  phone: z.string().trim().max(20).optional(),
});

router.put('/profile', authenticate, validate(profileSchema), async (req, res) => {
  const body = req.body as z.infer<typeof profileSchema>;
  const user = await User.findById(req.user!._id);
  if (!user) throw AppError.notFound('User');
  user.name = body.name;
  user.set('email', body.email || undefined);
  user.set('phone', body.phone || undefined);
  if (!user.email && !user.phone) throw AppError.badRequest('Email or phone is required to sign in');
  await user.save();
  ok(res, await sessionPayload(String(user._id)));
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

router.put('/password', authenticate, validate(passwordSchema), async (req, res) => {
  const body = req.body as z.infer<typeof passwordSchema>;
  const user = await User.findById(req.user!._id).select('+passwordHash');
  if (!user || !(await bcrypt.compare(body.currentPassword, user.passwordHash))) throw AppError.badRequest('Current password is incorrect');
  user.passwordHash = await bcrypt.hash(body.newPassword, 12);
  user.passwordChangedAt = new Date();
  await user.save();
  await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await issueTokens(res, String(user._id), { ip: req.ip, ua: req.header('user-agent') });
  ok(res, { changed: true });
});

export default router;

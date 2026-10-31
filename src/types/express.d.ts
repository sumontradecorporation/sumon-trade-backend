import type { Types } from 'mongoose';
import type { CompanySettings } from '../core/settings.js';

declare global {
  namespace Express {
    interface AuthUser {
      _id: Types.ObjectId;
      name: string;
      email?: string | null;
      phone?: string | null;
      isSuperAdmin: boolean;
      company?: Types.ObjectId | null;
      role?: { _id: Types.ObjectId; name: string; permissions: string[] } | null;
      permissions: string[];
      approvalRequired: string[];
    }
    interface CompanyCtx {
      companyId: Types.ObjectId;
      companyName: string;
      userId: Types.ObjectId;
      userName: string;
      isSuperAdmin: boolean;
      settings: CompanySettings;
      perms: Set<string>;
      approvalRequired: Set<string>;
      ip?: string;
      ua?: string;
    }
    interface Request {
      user?: AuthUser;
      ctx?: CompanyCtx;
    }
  }
}

export {};

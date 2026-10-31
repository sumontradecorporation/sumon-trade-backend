import { Router } from 'express';
import { ok } from '../../core/http.js';
import { APPROVABLE_PERMISSIONS, PERMISSION_GROUPS } from '../../core/permissions.js';
import { TXN_CONFIG } from '../../core/txn.js';
const router = Router();
router.get('/permissions', (_req, res) => ok(res, PERMISSION_GROUPS.map((g) => ({ ...g, approvable: g.actions.filter((a) => APPROVABLE_PERMISSIONS.includes(`${g.resource}.${a}`)) }))));
router.get('/txn-config', (_req, res) => ok(res, TXN_CONFIG));
export default router;
//# sourceMappingURL=routes.js.map
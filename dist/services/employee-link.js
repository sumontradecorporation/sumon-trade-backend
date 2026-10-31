import { AppError } from '../core/errors.js';
import { Employee, User } from '../models/index.js';
/** Throws unless the user / employee belongs to the company. */
export async function assertLinkable(company, ids) {
    if (ids.user && !(await User.exists({ _id: ids.user, company })))
        throw AppError.badRequest('The selected login does not belong to this company');
    if (ids.employee && !(await Employee.exists({ _id: ids.employee, company })))
        throw AppError.badRequest('The selected employee does not belong to this company');
}
/**
 * Keeps the one-to-one link between a login (User) and an HR profile (Employee) consistent on both sides.
 * Linking detaches the user from any other employee and the employee from any other user.
 */
export async function linkEmployeeUser(company, employee, user) {
    await Promise.all([
        User.updateMany({ company, employee, ...(user ? { _id: { $ne: user } } : {}) }, { $unset: { employee: 1 } }),
        user ? Employee.updateMany({ company, user, _id: { $ne: employee } }, { $unset: { user: 1 } }) : null,
    ]);
    await Promise.all([
        Employee.updateOne({ _id: employee, company }, user ? { $set: { user } } : { $unset: { user: 1 } }),
        user ? User.updateOne({ _id: user, company }, { $set: { employee } }) : null,
    ]);
}
/** Detaches a login from whichever employee profile it was linked to. */
export async function unlinkUser(company, user) {
    await Promise.all([Employee.updateMany({ company, user }, { $unset: { user: 1 } }), User.updateOne({ _id: user, company }, { $unset: { employee: 1 } })]);
}
//# sourceMappingURL=employee-link.js.map
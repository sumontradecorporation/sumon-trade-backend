/**
 * Sets a new password from the server's command line, for when nobody who could reset it in the app
 * can sign in (typically a forgotten super admin password).
 *   npm run reset-password -- <email or phone> <new password>
 *   npm run reset-password:prod -- <email or phone> <new password>   (from the compiled build)
 * The user is signed out everywhere and unblocked if they were blocked.
 */
import bcrypt from 'bcryptjs';
import { connectDB, disconnectDB } from '../config/db.js';
import { AuditLog, RefreshToken, User } from '../models/index.js';
async function main() {
    const [identifier, password] = process.argv.slice(2);
    if (!identifier || !password)
        throw new Error('Usage: npm run reset-password -- <email or phone> <new password>');
    if (password.length < 8)
        throw new Error('The password must be at least 8 characters.');
    await connectDB();
    const user = await User.findOne({ $or: [{ email: identifier.toLowerCase() }, { phone: identifier }] });
    if (!user)
        throw new Error(`No user has the email or phone "${identifier}".`);
    user.passwordHash = await bcrypt.hash(password, 12);
    user.passwordChangedAt = new Date();
    user.status = 'active';
    await user.save();
    await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await AuditLog.create({
        company: user.company, userName: 'Server console', action: 'reset_password', entity: 'User', entityId: user._id,
        label: `Password reset from the server console for ${user.name}`,
    });
    console.log(`✔ New password set for ${user.name} (${user.email ?? user.phone}). They were signed out on every device.`);
}
main()
    .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
})
    .finally(() => disconnectDB());
//# sourceMappingURL=reset-password.js.map
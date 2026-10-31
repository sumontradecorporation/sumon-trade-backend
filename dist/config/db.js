import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';
mongoose.set('strictQuery', true);
export async function connectDB(uri = env.MONGODB_URI) {
    await mongoose.connect(uri, { autoIndex: true });
    logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
    return mongoose.connection;
}
export async function disconnectDB() {
    await mongoose.disconnect();
}
//# sourceMappingURL=db.js.map
import { createClient } from 'redis';
import { env } from '../config/env.js';
export const redis = createClient({ url: env.REDIS_URL });
redis.on('error', (error) => console.error('Redis error', error));
export const connectRedis = () => redis.isOpen ? Promise.resolve() : redis.connect();

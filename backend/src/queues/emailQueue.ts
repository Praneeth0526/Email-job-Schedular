import { Queue } from 'bullmq';
import { env } from '../config/env.js';
export const connection = { url: env.REDIS_URL };
export const emailQueue = new Queue('email-sending', { connection, defaultJobOptions: { attempts: env.RETRY_ATTEMPTS, backoff: { type: 'exponential', delay: env.RETRY_BACKOFF_MS }, removeOnComplete: 1000, removeOnFail: 5000 } });
export type EmailQueueData = { emailId: string };
export async function enqueueEmail(emailId: string, scheduledAt: Date) { return emailQueue.add('send-email', { emailId }, { jobId: emailId, delay: Math.max(0, scheduledAt.getTime() - Date.now()) }); }

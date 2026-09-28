import { Worker, DelayedError, Job } from 'bullmq';
import { env } from '../config/env.js';
import { connection } from '../queues/emailQueue.js';
import { prisma } from '../db/prisma.js';
import { redis, connectRedis } from '../db/redis.js';
import { sendEmail } from '../services/emailService.js';
import { notifyRateLimit } from '../services/slackService.js';
const hourKey = (senderId: string) => { const d = new Date(); const stamp = d.toISOString().slice(0, 13).replace(/[-T:]/g, ''); return { key: `rl:${senderId}:${stamp}`, window: stamp, next: new Date(d) }; };
async function checkLimit(job: Job<{ emailId: string }>) { const email = await prisma.emailJob.findUnique({ where: { id: job.data.emailId } }); if (!email) return true; const { key, window, next } = hourKey(email.senderId); const limit = email.hourlyLimit || env.MAX_EMAILS_PER_HOUR_PER_SENDER; const count = await redis.incr(key); if (count === 1) await redis.expire(key, 3700); if (count <= limit) return true; await redis.decr(key); next.setMinutes(60, 0, 0); const offset = Math.min(59000, Math.max(1000, (count - limit) * env.MIN_DELAY_BETWEEN_EMAILS_MS)); const timestamp = next.getTime() + offset; await prisma.emailJob.update({ where: { id: email.id }, data: { scheduledAt: new Date(timestamp), status: 'scheduled' } }); const flag = `rl-notified:${email.userId}:${email.senderId}:${window}`; if (await redis.set(flag, '1', { NX: true, EX: 3700 })) await notifyRateLimit(email.userId, email.senderId, window); await job.moveToDelayed(timestamp, job.token); throw new DelayedError(); }
export async function startWorker() { await connectRedis(); const worker = new Worker('email-sending', async (job) => { if (await checkLimit(job)) await sendEmail(job.data.emailId); }, { connection, concurrency: env.WORKER_CONCURRENCY, limiter: { max: 1, duration: env.MIN_DELAY_BETWEEN_EMAILS_MS } }); worker.on('failed', (job, error) => console.error('email job failed', job?.id, error.message)); return worker; }

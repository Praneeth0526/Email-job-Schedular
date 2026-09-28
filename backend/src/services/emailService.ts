import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { enqueueEmail } from '../queues/emailQueue.js';
import { indexEmail } from '../db/elasticsearch.js';
export type ScheduleInput = { subject: string; body: string; recipients: string[]; startTime: string; delayBetweenMs: number; hourlyLimit: number };
export async function scheduleEmails(userId: string, input: ScheduleInput) {
  const senders = await prisma.sender.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  if (!senders.length) throw new Error('No senders configured. Run the Ethereal seed script first.');
  const start = new Date(input.startTime); const batchId = randomUUID();
  const data = input.recipients.map((toEmail, index) => ({ userId, senderId: senders[index % senders.length].id, toEmail, subject: input.subject, body: input.body, scheduledAt: new Date(start.getTime() + index * input.delayBetweenMs), batchId, hourlyLimit: input.hourlyLimit }));
  const jobs = await prisma.emailJob.createManyAndReturn({ data });
  await enqueueEmailBulk(jobs);
  await Promise.all(jobs.map((job) => indexEmail(job)));
  return { batchId, count: jobs.length };
}
async function enqueueEmailBulk(jobs: Array<{ id: string; scheduledAt: Date }>) { await emailQueueBulk(jobs); }
async function emailQueueBulk(jobs: Array<{ id: string; scheduledAt: Date }>) { const { emailQueue } = await import('../queues/emailQueue.js'); await emailQueue.addBulk(jobs.map((job) => ({ name: 'send-email', data: { emailId: job.id }, opts: { jobId: job.id, delay: Math.max(0, job.scheduledAt.getTime() - Date.now()) } }))); }
export async function reconcileEmails() { const jobs = await prisma.emailJob.findMany({ where: { status: { in: ['scheduled', 'processing'] } } }); const { emailQueue } = await import('../queues/emailQueue.js'); const existing = await emailQueue.getJobs(['delayed', 'waiting', 'active']); const ids = new Set(existing.map((job) => job.id)); await emailQueue.addBulk(jobs.filter((job) => !ids.has(job.id)).map((job) => ({ name: 'send-email', data: { emailId: job.id }, opts: { jobId: job.id, delay: Math.max(0, job.scheduledAt.getTime() - Date.now()) } }))); }
export async function sendEmail(emailId: string) {
  const job = await prisma.emailJob.findUnique({ where: { id: emailId }, include: { sender: true } }); if (!job || job.status === 'sent') return;
  const claimed = await prisma.emailJob.updateMany({ where: { id: emailId, status: 'scheduled' }, data: { status: 'processing', attempts: { increment: 1 } } }); if (claimed.count !== 1) return;
  try { const transport = nodemailer.createTransport({ host: job.sender.smtpHost, port: job.sender.smtpPort, auth: { user: job.sender.smtpUser, pass: job.sender.smtpPass } }); const result = await transport.sendMail({ from: job.sender.email, to: job.toEmail, subject: job.subject, text: job.body }); const previewUrl = nodemailer.getTestMessageUrl(result) || null; await prisma.emailJob.update({ where: { id: emailId }, data: { status: 'sent', sentAt: new Date(), previewUrl } }); const { updateEmailIndex } = await import('../db/elasticsearch.js'); await updateEmailIndex(emailId, 'sent', { sentAt: new Date(), previewUrl }); } catch (error) { await prisma.emailJob.update({ where: { id: emailId }, data: { status: 'failed', error: error instanceof Error ? error.message : String(error) } }); const { updateEmailIndex } = await import('../db/elasticsearch.js'); await updateEmailIndex(emailId, 'failed', { error: String(error) }); throw error; }
}

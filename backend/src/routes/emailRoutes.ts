import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { es, EMAIL_INDEX } from '../db/elasticsearch.js';
import { scheduleEmails } from '../services/emailService.js';
import { AuthRequest } from '../types/auth.js';
const router = Router();
const bodySchema = z.object({ subject: z.string().min(1), body: z.string().min(1), recipients: z.array(z.string().email()).min(1), startTime: z.string().datetime(), delayBetweenMs: z.number().int().nonnegative(), hourlyLimit: z.number().int().positive() });
router.post('/schedule', async (req: AuthRequest, res) => { const input = bodySchema.parse(req.body); res.status(201).json(await scheduleEmails(req.userId!, { ...input, recipients: [...new Set(input.recipients)] })); });
async function list(req: AuthRequest, status: 'scheduled' | 'sent' | 'failed') { const page = Math.max(1, Number(req.query.page) || 1); const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25)); const where = { userId: req.userId!, status }; const [items, total] = await Promise.all([prisma.emailJob.findMany({ where, orderBy: { scheduledAt: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }), prisma.emailJob.count({ where })]); return { items, total, page, pageSize, pages: Math.ceil(total / pageSize) }; }
router.get('/scheduled', async (req: AuthRequest, res) => res.json(await list(req, 'scheduled'))); router.get('/sent', async (req: AuthRequest, res) => { const result = await list(req, 'sent'); const failed = await list(req, 'failed'); res.json({ ...result, items: [...result.items, ...failed.items], total: result.total + failed.total }); });
router.get('/search', async (req: AuthRequest, res) => { const q = String(req.query.q || '').trim(); if (!q) return res.json({ items: [] }); const result = await es.search({ index: EMAIL_INDEX, query: { bool: { must: { multi_match: { query: q, fields: ['subject', 'body', 'toEmail'] } }, filter: { term: { userId: req.userId } } } } }); res.json({ items: result.hits.hits.map((hit) => ({ id: hit._id, ...hit._source })) }); });
export default router;

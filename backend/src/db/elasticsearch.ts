import { Client } from '@elastic/elasticsearch';
import { env } from '../config/env.js';
export const es = new Client({ node: env.ELASTICSEARCH_URL });
export const EMAIL_INDEX = 'email_jobs';
export async function ensureEmailIndex() {
  if (!(await es.indices.exists({ index: EMAIL_INDEX })).valueOf()) await es.indices.create({ index: EMAIL_INDEX, mappings: { properties: { userId: { type: 'keyword' }, subject: { type: 'text' }, body: { type: 'text' }, toEmail: { type: 'text' }, status: { type: 'keyword' }, scheduledAt: { type: 'date' } } } });
}
export async function indexEmail(job: { id: string; userId: string; subject: string; body: string; toEmail: string; status: string; scheduledAt: Date }) { await es.index({ index: EMAIL_INDEX, id: job.id, document: job }); }
export async function updateEmailIndex(id: string, status: string, fields: Record<string, unknown> = {}) { await es.update({ index: EMAIL_INDEX, id, doc: { status, ...fields } }).catch(() => undefined); }

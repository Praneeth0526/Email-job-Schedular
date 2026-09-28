import axios from 'axios';
import type { EmailJob, Paginated, SlackStatus, User } from '../types';

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api', withCredentials: true });
export const authApi = { me: () => api.get<User>('/auth/me'), logout: () => api.post('/auth/logout') };
export const emailApi = {
  schedule: (payload: { subject: string; body: string; recipients: string[]; startTime: string; delayBetweenMs: number; hourlyLimit: number }) => api.post<{ batchId: string; count: number }>('/emails/schedule', payload),
  list: (kind: 'scheduled' | 'sent', page: number, q = '') => q ? api.get<{ items: EmailJob[] }>(`/emails/search?q=${encodeURIComponent(q)}`) : api.get<Paginated<EmailJob>>(`/emails/${kind}?page=${page}&pageSize=10`),
};
export const slackApi = { status: () => api.get<SlackStatus>('/slack/status'), disconnect: () => api.delete('/slack/disconnect') };
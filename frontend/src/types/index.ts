export type User = { id: string; name: string; email: string; avatar?: string | null };
export type EmailJob = { id: string; toEmail: string; subject: string; body: string; scheduledAt: string; sentAt?: string | null; status: 'scheduled' | 'processing' | 'sent' | 'failed'; previewUrl?: string | null; error?: string | null };
export type Paginated<T> = { items: T[]; total: number; page: number; pageSize: number; pages: number };
export type SlackStatus = { connected: boolean; teamName?: string | null; channel?: string | null };
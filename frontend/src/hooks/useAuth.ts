import { useEffect, useState } from 'react';
import { authApi } from '../services/api';
import type { User } from '../types';
export function useAuth() { const [user, setUser] = useState<User | null>(null); const [loading, setLoading] = useState(true); useEffect(() => { authApi.me().then(({ data }) => setUser(data)).catch(() => setUser(null)).finally(() => setLoading(false)); }, []); return { user, loading, logout: async () => { await authApi.logout(); setUser(null); } }; }
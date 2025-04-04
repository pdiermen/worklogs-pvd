import React, { useState } from 'react';

export default function WorkLogs() {
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const [worklogsHtml, setWorklogsHtml] = useState<string>('');

    const fetchWorkLogs = async () => {
        if (!startDate || !endDate) {
            setError('Vul beide datums in');
            return;
        }

        setLoading(true);
        setError(null);
        try {
            const response = await fetch(`/api/worklogs?startDate=${startDate}&endDate=${endDate}`);
            if (!response.ok) {
                throw new Error('Fout bij ophalen worklogs');
            }
            const html = await response.text();
            setWorklogsHtml(html);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Onbekende fout');
        } finally {
            setLoading(false);
        }
    };

    if (loading) return <div>Laden...</div>;
    if (error) return <div>Error: {error}</div>;

    return (
        <div className="container mx-auto px-4 py-8">
            <div className="mb-8">
                <h1 className="text-2xl font-bold mb-4">Worklogs Dashboard</h1>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Startdatum
                        </label>
                        <input
                            type="date"
                            value={startDate}
                            onChange={(e) => setStartDate(e.target.value)}
                            className="w-full p-2 border rounded"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Einddatum
                        </label>
                        <input
                            type="date"
                            value={endDate}
                            onChange={(e) => setEndDate(e.target.value)}
                            className="w-full p-2 border rounded"
                        />
                    </div>
                    <div className="flex items-end">
                        <button
                            onClick={fetchWorkLogs}
                            disabled={loading}
                            className="w-full bg-blue-500 text-white p-2 rounded hover:bg-blue-600 disabled:bg-blue-300"
                        >
                            {loading ? 'Laden...' : 'Laad Worklogs'}
                        </button>
                    </div>
                </div>
            </div>

            {error && (
                <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
                    {error}
                </div>
            )}

            <div dangerouslySetInnerHTML={{ __html: worklogsHtml }} />
        </div>
    );
} 
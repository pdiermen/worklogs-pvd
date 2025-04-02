import React, { useState } from 'react';
import { formatTime } from '../utils/time';

interface WorkLog {
    issueKey: string;
    issueSummary: string;
    author: string;
    timeSpentSeconds: number;
    started: string;
    comment: string;
    estimatedTime: number;
}

interface EfficiencyData {
    assignee: string;
    estimated: string;
    logged: string;
    efficiency: string;
}

interface WorkLogsResponse {
    workLogs: WorkLog[];
    efficiencyTable: EfficiencyData[];
}

export default function WorkLogs() {
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [workLogs, setWorkLogs] = useState<WorkLog[]>([]);
    const [efficiencyData, setEfficiencyData] = useState<EfficiencyData[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const fetchWorkLogs = async () => {
        if (!startDate || !endDate) {
            setError('Vul beide datums in');
            return;
        }

        setLoading(true);
        setError('');

        try {
            const response = await fetch(`/api/worklogs?startDate=${startDate}&endDate=${endDate}`);
            if (!response.ok) {
                throw new Error('Fout bij ophalen worklogs');
            }
            const data: WorkLogsResponse = await response.json();
            setWorkLogs(data.workLogs);
            setEfficiencyData(data.efficiencyTable);
        } catch (err) {
            setError('Er is een fout opgetreden bij het ophalen van de worklogs');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="container mx-auto p-4">
            <h1 className="text-2xl font-bold mb-4">Worklogs</h1>
            
            <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700">Start datum:</label>
                <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                />
            </div>

            <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700">Eind datum:</label>
                <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                />
            </div>

            <button
                onClick={fetchWorkLogs}
                disabled={loading}
                className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 disabled:bg-gray-400"
            >
                {loading ? 'Laden...' : 'Ophalen'}
            </button>

            {error && (
                <div className="mt-4 p-4 bg-red-100 text-red-700 rounded">
                    {error}
                </div>
            )}

            {efficiencyData.length > 0 && (
                <div className="mt-8">
                    <h2 className="text-xl font-bold mb-4">Efficiency per medewerker</h2>
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Medewerker</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Estimated</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Gelogd</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Efficiency</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {efficiencyData.map((data, index) => (
                                    <tr key={index}>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{data.assignee}</td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{data.estimated}</td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{data.logged}</td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{data.efficiency}%</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {workLogs.length > 0 && (
                <div className="mt-8">
                    <h2 className="text-xl font-bold mb-4">Worklogs</h2>
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Issue</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Medewerker</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tijd</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Datum</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Comment</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {workLogs.map((log, index) => (
                                    <tr key={index}>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{log.issueKey}</td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{log.author}</td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{formatTime(log.timeSpentSeconds)}</td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{new Date(log.started).toLocaleDateString()}</td>
                                        <td className="px-6 py-4 text-sm text-gray-500">{log.comment}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
} 
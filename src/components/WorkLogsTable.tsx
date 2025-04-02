import React from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Typography
} from '@mui/material';
import type { WorkLog } from '../types';

interface WorkLogsTableProps {
  workLogs: WorkLog[];
}

export const WorkLogsTable: React.FC<WorkLogsTableProps> = ({ workLogs }) => {
  // Groepeer worklogs per medewerker
  const workLogsByAssignee = workLogs.reduce((acc, log) => {
    if (!acc[log.author]) {
      acc[log.author] = [];
    }
    acc[log.author].push(log);
    return acc;
  }, {} as Record<string, WorkLog[]>);

  // Bereken totalen voor alle categorieën
  const totals = {
    notWorked: 0,
    nonBillable: 0,
    productDev: 0
  };

  Object.values(workLogsByAssignee).forEach(logs => {
    totals.notWorked += logs.filter(log => log.comment.toLowerCase().includes('niet gewerkt')).reduce((sum, log) => sum + log.timeSpentSeconds, 0);
    totals.nonBillable += logs.filter(log => log.comment.toLowerCase().includes('overige niet-declarabel')).reduce((sum, log) => sum + log.timeSpentSeconds, 0);
    totals.productDev += logs.filter(log => log.comment.toLowerCase().includes('productontwikkeling')).reduce((sum, log) => sum + log.timeSpentSeconds, 0);
  });

  const grandTotal = totals.notWorked + totals.nonBillable + totals.productDev;

  return (
    <div>
      <Typography variant="h6" gutterBottom>
        Werk uren per medewerker
      </Typography>
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Medewerker</TableCell>
              <TableCell align="right">Niet gewerkt</TableCell>
              <TableCell align="right">Overige niet-declarabel</TableCell>
              <TableCell align="right">Productontwikkeling</TableCell>
              <TableCell align="right">Totaal</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {Object.entries(workLogsByAssignee).map(([assignee, logs]) => {
              const notWorked = logs.filter(log => log.comment.toLowerCase().includes('niet gewerkt')).reduce((sum, log) => sum + log.timeSpentSeconds, 0);
              const nonBillable = logs.filter(log => log.comment.toLowerCase().includes('overige niet-declarabel')).reduce((sum, log) => sum + log.timeSpentSeconds, 0);
              const productDev = logs.filter(log => log.comment.toLowerCase().includes('productontwikkeling')).reduce((sum, log) => sum + log.timeSpentSeconds, 0);
              const total = notWorked + nonBillable + productDev;

              return (
                <TableRow key={assignee}>
                  <TableCell>{assignee}</TableCell>
                  <TableCell align="right">{(notWorked / 3600).toFixed(1)}</TableCell>
                  <TableCell align="right">{(nonBillable / 3600).toFixed(1)}</TableCell>
                  <TableCell align="right">{(productDev / 3600).toFixed(1)}</TableCell>
                  <TableCell align="right">{(total / 3600).toFixed(1)}</TableCell>
                </TableRow>
              );
            })}
            <TableRow>
              <TableCell>Totaal</TableCell>
              <TableCell align="right">{(totals.notWorked / 3600).toFixed(1)}</TableCell>
              <TableCell align="right">{(totals.nonBillable / 3600).toFixed(1)}</TableCell>
              <TableCell align="right">{(totals.productDev / 3600).toFixed(1)}</TableCell>
              <TableCell align="right">{(grandTotal / 3600).toFixed(1)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>
    </div>
  );
}; 
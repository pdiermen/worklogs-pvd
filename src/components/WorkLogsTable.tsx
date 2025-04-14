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
  resourceIssues: {
    nietGewerkt: string[];
    overigeNietDeclarabel: string[];
    productontwikkeling: string[];
  };
}

export const WorkLogsTable: React.FC<WorkLogsTableProps> = ({ workLogs, resourceIssues }) => {
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
    // Log de filtering criteria
    console.info('Filtering criteria voor worklogs:');
    console.info('- Niet gewerkt: comment bevat "niet gewerkt" OF issue is in nietGewerkt lijst');
    console.info('- Overige niet-declarabel: comment bevat "overige niet-declarabel" OF issue is in overigeNietDeclarabel lijst');
    console.info('- Productontwikkeling: comment bevat "productontwikkeling" OF issue is in productontwikkeling lijst');

    // Log het aantal worklogs voor deze medewerker
    console.info(`Aantal worklogs voor deze medewerker: ${logs.length}`);

    // Log het aantal worklogs per categorie
    const nietGewerktLogs = logs.filter(log => {
      const comment = log.comment?.toLowerCase() || '';
      const isNietGewerktComment = comment.includes('niet gewerkt');
      const isNietGewerktIssue = resourceIssues.nietGewerkt.includes(log.issueKey);
      return isNietGewerktComment || isNietGewerktIssue;
    });

    const overigeNietDeclarabelLogs = logs.filter(log => {
      const comment = log.comment?.toLowerCase() || '';
      const isOverigeNietDeclarabelComment = comment.includes('overige niet-declarabel');
      const isOverigeNietDeclarabelIssue = resourceIssues.overigeNietDeclarabel.includes(log.issueKey);
      return isOverigeNietDeclarabelComment || isOverigeNietDeclarabelIssue;
    });

    const productontwikkelingLogs = logs.filter(log => {
      const comment = log.comment?.toLowerCase() || '';
      const isProductontwikkelingComment = comment.includes('productontwikkeling');
      const isProductontwikkelingIssue = resourceIssues.productontwikkeling.includes(log.issueKey);
      return isProductontwikkelingComment || isProductontwikkelingIssue;
    });

    console.info(`Aantal worklogs per categorie:`);
    console.info(`- Niet gewerkt: ${nietGewerktLogs.length}`);
    console.info(`- Overige niet-declarabel: ${overigeNietDeclarabelLogs.length}`);
    console.info(`- Productontwikkeling: ${productontwikkelingLogs.length}`);

    totals.notWorked += nietGewerktLogs.reduce((sum, log) => sum + log.timeSpentSeconds, 0);
    totals.nonBillable += overigeNietDeclarabelLogs.reduce((sum, log) => sum + log.timeSpentSeconds, 0);
    totals.productDev += productontwikkelingLogs.reduce((sum, log) => sum + log.timeSpentSeconds, 0);
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
              const notWorked = logs.filter(log => log.comment?.toLowerCase().includes('niet gewerkt')).reduce((sum, log) => sum + log.timeSpentSeconds, 0);
              const nonBillable = logs.filter(log => log.comment?.toLowerCase().includes('overige niet-declarabel')).reduce((sum, log) => sum + log.timeSpentSeconds, 0);
              const productDev = logs.filter(log => log.comment?.toLowerCase().includes('productontwikkeling')).reduce((sum, log) => sum + log.timeSpentSeconds, 0);
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
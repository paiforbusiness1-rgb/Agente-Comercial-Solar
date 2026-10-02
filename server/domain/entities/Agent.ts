/**
 * Agent.ts
 * Domain entity for commercial agents who handle qualified lead handoffs.
 * Single Responsibility: pure data definition (Anti-God-Object Rule 3).
 */

export interface Agent {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  whatsappPhone: string; // International format without '+': "5214771234567"
  isActive: boolean;
  assignedLeadsCount: number;
  createdAt: string;
  updatedAt: string;
}

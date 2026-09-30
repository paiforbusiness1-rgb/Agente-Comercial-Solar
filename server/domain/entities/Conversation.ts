// ──────────────────────────────────────────────
// DOMAIN ENTITIES
// ──────────────────────────────────────────────

export type ConversationPhase =
  | 'GREETING'
  | 'QUALIFICATION'
  | 'TECHNICAL_SURVEY'
  | 'QUOTATION'
  | 'FINANCING'
  | 'CLOSING'
  | 'LEAD_GENERATED'
  | 'HUMAN_HANDOFF';

export interface ConversationState {
  phase: ConversationPhase;
  completedSteps: string[];
  missingFields: string[];
  leadScore: number;       // 0–100
  intent?: string;
  clientName?: string;
  monthlyBill?: number;
  isOwner?: boolean;
  roofType?: string;
  hasShade?: boolean;
  voltage?: string;
  floors?: number;
  quoteConsentRequested?: boolean;
  quoteConsentGiven?: boolean;
  mediaSentFlags?: {
    instalacionProfessional?: boolean;
    financiamiento?: boolean;
  };
}

export interface Message {
  sender: 'user' | 'bot' | 'agent';
  text: string;
  timestamp: string;
}

export interface Conversation {
  id: string;
  tenantId: string;
  phone: string;
  nombre: string;
  botDisabled: boolean;
  messages: Message[];
  state: ConversationState;
  lastMessageAt: string;
  createdAt: string;
  // Legacy lead fields (kept for backward compat with Firestore)
  montoRecibo?: string;
  sistemaEstimado?: string;
  costoEstimado?: string;
}

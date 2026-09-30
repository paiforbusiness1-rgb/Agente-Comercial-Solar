import { Conversation } from '../entities/Conversation.js';

export interface IConversationRepository {
  findByPhone(tenantId: string, phone: string): Promise<Conversation>;
  save(conversation: Conversation): Promise<void>;
  findAll(tenantId: string): Promise<Conversation[]>;
  softDelete(tenantId: string, phone: string, deletedBy: string): Promise<boolean>;
  restore(tenantId: string, phone: string): Promise<boolean>;
  findTrash(tenantId: string): Promise<Conversation[]>;
  purgeExpiredTrash(tenantId: string, daysRetention?: number): Promise<number>;
}

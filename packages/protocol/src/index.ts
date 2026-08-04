import { z } from "zod";

export const queuePreferencesSchema = z.object({
  language: z.string().trim().min(2).max(12).default("en"),
  interests: z
    .array(z.string().trim().toLowerCase().min(2).max(32))
    .max(5)
    .transform((interests) => [...new Set(interests)]),
});

export const chatMessageSchema = z.object({
  clientMessageId: z.string().uuid(),
  body: z.string().trim().min(1).max(1_000),
});

export const reportSchema = z.object({
  reason: z.enum(["harassment", "sexual-content", "hate", "spam", "minor-safety", "other"]),
  details: z.string().trim().max(500).optional(),
});

export type QueuePreferences = z.infer<typeof queuePreferencesSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type Report = z.infer<typeof reportSchema>;

export type ClientToServerEvents = {
  joinQueue: (preferences: QueuePreferences) => void;
  leaveQueue: () => void;
  next: () => void;
  message: (message: ChatMessage) => void;
  reportPeer: (report: Report) => void;
};

export type ServerToClientEvents = {
  queueJoined: () => void;
  matched: (match: { matchId: string; sharedInterests: string[] }) => void;
  message: (message: ChatMessage & { sequence: number; sentAt: string }) => void;
  peerLeft: () => void;
  queueError: (error: { code: string; message: string }) => void;
  reported: () => void;
};

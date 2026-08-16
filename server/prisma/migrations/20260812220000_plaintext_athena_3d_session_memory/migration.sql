-- 3D Center Session Memory is latency-first, session-scoped state. Its payloads
-- are canonical JSON and do not use the application Key Custody envelope.
ALTER TABLE "responses" ADD COLUMN "storageMode" TEXT NOT NULL DEFAULT 'encrypted';
ALTER TABLE "responses_conversations" RENAME COLUMN "stateCiphertext" TO "stateJson";
ALTER TABLE "character_conversation_turns" RENAME COLUMN "inputCiphertext" TO "inputJson";
ALTER TABLE "character_conversation_turns" RENAME COLUMN "controlCiphertext" TO "controlJson";
ALTER TABLE "character_conversation_events" RENAME COLUMN "payloadCiphertext" TO "payloadJson";

ALTER TABLE "character_performance_sessions" RENAME COLUMN "clientCiphertext" TO "clientJson";
ALTER TABLE "character_performance_plans" RENAME COLUMN "planCiphertext" TO "planJson";
ALTER TABLE "character_performance_events" RENAME COLUMN "payloadCiphertext" TO "payloadJson";
ALTER TABLE "character_performance_feedback" RENAME COLUMN "payloadCiphertext" TO "payloadJson";

ALTER TABLE "athena_3d_session_memory_turns" RENAME COLUMN "userCiphertext" TO "userJson";
ALTER TABLE "athena_3d_session_memory_turns" RENAME COLUMN "assistantCiphertext" TO "assistantJson";

ALTER TABLE "athena_3d_session_memory_checkpoints" RENAME COLUMN "summaryCiphertext" TO "summaryJson";

ALTER TABLE "athena_3d_character_state_windows" RENAME COLUMN "previousCiphertext" TO "previousStateJson";
ALTER TABLE "athena_3d_character_state_windows" RENAME COLUMN "transitionCiphertext" TO "transitionJson";
ALTER TABLE "athena_3d_character_state_windows" RENAME COLUMN "currentCiphertext" TO "currentStateJson";

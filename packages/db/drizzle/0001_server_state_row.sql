-- Custom SQL migration file, put your code below! --
-- The single fencing-epoch row (ARCHITECTURE §5.5): boot runs
-- UPDATE server_state SET epoch = epoch + 1 RETURNING epoch, which needs this row to exist.
INSERT INTO "server_state" ("id", "epoch") VALUES (1, 0) ON CONFLICT ("id") DO NOTHING;

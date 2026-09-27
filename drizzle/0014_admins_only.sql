-- 役割を「管理者」と「会員」の 2 つにする。オーナーは管理者にする（管理者どうしは対等）
UPDATE "users" SET "role" = 'admin' WHERE "role" = 'owner';

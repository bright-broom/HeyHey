-- グループの役割を「管理人（owner）」と「メンバー」の 2 つにする。モデレーターはメンバーに戻す
UPDATE "group_members" SET "role" = 'member' WHERE "role" = 'moderator';

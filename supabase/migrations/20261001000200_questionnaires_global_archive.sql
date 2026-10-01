-- 问卷存档跨所有本机会话展示；该索引支持按用户和时间分页读取。
create index if not exists milk_questionnaires_user_time
  on public.milk_questionnaires(user_id, sent_at desc);

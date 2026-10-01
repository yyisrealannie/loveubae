-- “我想了解你多一点”：每个问卷仅属于创建它的登录用户。
create table if not exists public.milk_questionnaires (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null,
  title text not null,
  questions jsonb not null,
  answers jsonb,
  status text not null default 'pending',
  sent_at timestamptz not null,
  answer_due_at timestamptz not null,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint milk_questionnaires_session_length check (length(session_id) between 1 and 120),
  constraint milk_questionnaires_title_length check (length(title) between 1 and 80),
  constraint milk_questionnaires_questions_array check (
    jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) between 1 and 10
  ),
  constraint milk_questionnaires_answers_array check (
    answers is null or jsonb_typeof(answers) = 'array'
  ),
  constraint milk_questionnaires_status check (status in ('pending', 'completed')),
  constraint milk_questionnaires_completion check (
    (status = 'pending' and answers is null and answered_at is null)
    or
    (status = 'completed' and answers is not null and answered_at is not null)
  )
);

create index if not exists milk_questionnaires_user_session_time
  on public.milk_questionnaires(user_id, session_id, sent_at desc);
create index if not exists milk_questionnaires_pending_due
  on public.milk_questionnaires(user_id, answer_due_at)
  where status = 'pending';

alter table public.milk_questionnaires enable row level security;

drop policy if exists questionnaires_read_own on public.milk_questionnaires;
create policy questionnaires_read_own
on public.milk_questionnaires for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists questionnaires_create_own on public.milk_questionnaires;
create policy questionnaires_create_own
on public.milk_questionnaires for insert to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists questionnaires_complete_own on public.milk_questionnaires;
create policy questionnaires_complete_own
on public.milk_questionnaires for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

revoke all on public.milk_questionnaires from anon, authenticated;
grant select, insert on public.milk_questionnaires to authenticated;
grant update (answers, status, answered_at, updated_at) on public.milk_questionnaires to authenticated;

-- Recall: private Storage bucket for illustrations and covers.
-- Run after 0002. Objects live at  <user_id>/<book_id>/<image_id>.<ext>  and are
-- only readable/writable by their owner (first path segment = auth.uid()).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'book-images', 'book-images', false, 15728640,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "book images: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'book-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "book images: upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'book-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "book images: update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'book-images' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'book-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "book images: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'book-images' and (storage.foldername(name))[1] = auth.uid()::text);

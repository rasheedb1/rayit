-- =====================================================================
-- Seed 1 · Catálogo base. Idempotente: se puede correr N veces.
-- =====================================================================

INSERT INTO niche (slug, name_es, name_en) VALUES
  ('cocina',        'Cocina fácil',          'Easy cooking'),
  ('fitness',       'Fitness y bienestar',   'Fitness'),
  ('finanzas',      'Finanzas personales',   'Personal finance'),
  ('historia',      'Historia',              'History'),
  ('tecnologia',    'Tecnología',            'Technology'),
  ('viajes',        'Viajes',                'Travel'),
  ('belleza',       'Belleza y cuidado',     'Beauty'),
  ('hogar',         'Hogar y decoración',    'Home'),
  ('maternidad',    'Maternidad y crianza',  'Parenting'),
  ('humor',         'Humor',                 'Comedy'),
  ('educacion',     'Educación',             'Education'),
  ('mascotas',      'Mascotas',              'Pets')
ON CONFLICT (slug) DO NOTHING;

-- CPM de referencia para sugerir tarifas. Marcados como 'manual' porque
-- son estimaciones iniciales del mercado colombiano: se reemplazan en
-- cuanto tengamos deals reales cerrados en la plataforma, y la fuente
-- pasa a 'deals'. La UI muestra la procedencia.
INSERT INTO niche_cpm_benchmark
  (niche_slug, country, platform, currency, cpm_low, cpm_high, source, sample_size)
VALUES
  ('cocina',    'CO', 'tiktok',    'COP', 45000, 70000, 'manual', 0),
  ('cocina',    'CO', 'instagram', 'COP', 55000, 85000, 'manual', 0),
  ('cocina',    'CO', 'youtube',   'COP', 60000, 95000, 'manual', 0),
  ('fitness',   'CO', 'tiktok',    'COP', 50000, 80000, 'manual', 0),
  ('fitness',   'CO', 'instagram', 'COP', 60000, 95000, 'manual', 0),
  ('finanzas',  'CO', 'tiktok',    'COP', 70000,110000, 'manual', 0),
  ('finanzas',  'CO', 'instagram', 'COP', 85000,135000, 'manual', 0),
  ('belleza',   'CO', 'instagram', 'COP', 65000,100000, 'manual', 0),
  ('tecnologia','CO', 'youtube',   'COP', 75000,120000, 'manual', 0)
ON CONFLICT DO NOTHING;

INSERT INTO signal_source (id, label_es, kind) VALUES
  ('linkedin_jobs', 'Vacantes en LinkedIn', 'jobs')
ON CONFLICT (id) DO NOTHING;

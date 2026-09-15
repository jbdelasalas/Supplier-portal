import type { NextRequest } from 'next/server';
import { ok, err, handler } from '@/lib/api';
import { queryOne } from '@/lib/db';
import type { FormSchema } from '@/lib/forms';

export const dynamic = 'force-dynamic';

interface FormVersionRow {
  form_version_id: string;
  version: number;
  form_name: string;
  description: string | null;
  company_id: string;
  company_name: string;
  schema: FormSchema;
}

/**
 * Returns the currently published application form so the sign-up page can
 * render it. Public on purpose — it is a blank form, no supplier data.
 *
 *   GET /api/public/form?company=AFCC
 */
export const GET = handler(async (request: NextRequest) => {
  const companyCode = request.nextUrl.searchParams.get('company');

  const row = await queryOne<FormVersionRow>(
    `SELECT fv.id AS form_version_id, fv.version, fv.schema,
            f.name AS form_name, f.description,
            co.id AS company_id, co.name AS company_name
       FROM form_versions fv
       JOIN forms f      ON f.id = fv.form_id
       JOIN companies co ON co.id = f.company_id
      WHERE fv.status = 'published'
        AND f.is_active
        AND f.kind = 'supplier_accreditation'
        AND co.is_active
        AND ($1::text IS NULL OR co.code = $1)
      ORDER BY fv.version DESC
      LIMIT 1`,
    [companyCode],
  );

  if (!row) return err('No published application form is available.', 404);

  return ok({
    formVersionId: row.form_version_id,
    version: row.version,
    name: row.form_name,
    description: row.description,
    company: { id: row.company_id, name: row.company_name },
    schema: row.schema,
  });
});

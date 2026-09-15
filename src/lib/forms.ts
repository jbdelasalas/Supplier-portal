/**
 * The form engine.
 *
 * A form is a JSON schema stored in form_versions.schema. This module is the
 * only place that understands that shape: it types it, validates a submission
 * against it, and maps approved answers onto supplier columns. Adding a field
 * to a form is a data change, not a code change.
 */

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'email'
  | 'phone'
  | 'date'
  | 'url'
  | 'select'
  | 'multiselect'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'section_note';

export interface FieldOption {
  value: string;
  label: string;
}

/** Shows the field only when another field holds a given value. */
export interface ShowIf {
  field: string;
  equals?: string | number | boolean;
  in?: (string | number)[];
}

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
  options?: FieldOption[];
  showIf?: ShowIf;
  /** "suppliers.legal_name" — copied onto the supplier row on approval. */
  mapsTo?: string;
}

export interface FormSection {
  key: string;
  title: string;
  description?: string;
  fields: FormField[];
}

export interface FormDocument {
  key: string;
  label: string;
  required?: boolean;
  accept?: string[];
  maxSizeMb?: number;
}

/** A camera-captured photo the form asks for. */
export interface FormPhoto {
  key: string;
  label: string;
  hint?: string;
  /** 'user' = selfie (front camera), 'environment' = premises (rear camera). */
  facing?: 'user' | 'environment';
  required?: boolean;
}

/** The signing step shown at the end of the form. */
export interface FormSignature {
  key: string;
  label: string;
  required?: boolean;
  /** Stored verbatim with the signature, so we know what was agreed to. */
  declarationText: string;
}

export interface FormSchema {
  sections: FormSection[];
  documents?: FormDocument[];
  photos?: FormPhoto[];
  signature?: FormSignature;
  /**
   * The printed form, signed before a notary and uploaded back. Kept separate
   * from `documents` because it is produced FROM this application rather than
   * gathered beforehand, and the UI pairs it with the print action.
   */
  notarisedDocument?: FormDocument & { hint?: string };
}

export type FormData = Record<string, unknown>;

export interface ValidationError {
  field: string;
  message: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+()\-.\s]{7,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Google hands out map links from several hosts depending on how they were
 * shared — the short maps.app.goo.gl form from the mobile Share sheet, the
 * older goo.gl/maps, and full google.com/maps URLs on any country domain.
 * Matching on the host (not a substring of the whole URL) keeps a lookalike
 * domain from passing.
 */
function isMapsUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'maps.google.com') return true;
  // google.com, google.com.ph, google.co.uk … with a /maps path.
  if (/^(www\.)?google\.[a-z.]{2,6}$/.test(host) && url.pathname.startsWith('/maps')) return true;
  return false;
}

export function allFields(schema: FormSchema): FormField[] {
  return schema.sections.flatMap((s) => s.fields);
}

/** A field hidden by its showIf condition is neither required nor validated. */
export function isVisible(field: FormField, data: FormData): boolean {
  const cond = field.showIf;
  if (!cond) return true;

  const actual = data[cond.field];
  if (cond.in) return cond.in.some((v) => String(v) === String(actual));
  if (cond.equals !== undefined) return String(cond.equals) === String(actual);
  return actual !== undefined && actual !== null && actual !== '';
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Validates `data` against `schema`.
 *
 * `partial` is for draft saves: required-ness is skipped, but anything the
 * applicant did fill in is still checked, so a draft can't hold garbage that
 * only explodes at submit time.
 */
export function validateSubmission(
  schema: FormSchema,
  data: FormData,
  opts: { partial?: boolean } = {},
): ValidationError[] {
  const errors: ValidationError[] = [];
  const partial = opts.partial ?? false;

  for (const field of allFields(schema)) {
    if (field.type === 'section_note') continue;
    if (!isVisible(field, data)) continue;

    const value = data[field.key];

    if (isBlank(value)) {
      if (field.required && !partial) {
        errors.push({ field: field.key, message: `${field.label} is required.` });
      }
      continue;
    }

    switch (field.type) {
      case 'email':
        if (!EMAIL_RE.test(String(value))) {
          errors.push({ field: field.key, message: `${field.label} must be a valid email address.` });
        }
        break;

      case 'phone':
        if (!PHONE_RE.test(String(value))) {
          errors.push({ field: field.key, message: `${field.label} must be a valid phone number.` });
        }
        break;

      case 'date':
        if (!DATE_RE.test(String(value)) || Number.isNaN(Date.parse(String(value)))) {
          errors.push({ field: field.key, message: `${field.label} must be a valid date.` });
        }
        break;

      case 'url': {
        const raw = String(value).trim();
        let parsed: URL | null = null;
        try {
          parsed = new URL(raw);
        } catch {
          parsed = null;
        }

        if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
          errors.push({
            field: field.key,
            message: `${field.label} must be a link starting with https://`,
          });
        } else if (/map/i.test(field.key) && !isMapsUrl(parsed)) {
          // A maps field with a non-maps link is almost always a paste error,
          // and a wrong link sends a driver to the wrong place.
          errors.push({
            field: field.key,
            message: `${field.label} does not look like a Google Maps link. Use the Share option in Google Maps.`,
          });
        }
        break;
      }

      case 'number': {
        const n = Number(value);
        if (Number.isNaN(n)) {
          errors.push({ field: field.key, message: `${field.label} must be a number.` });
        } else {
          if (field.min !== undefined && n < field.min) {
            errors.push({ field: field.key, message: `${field.label} must be at least ${field.min}.` });
          }
          if (field.max !== undefined && n > field.max) {
            errors.push({ field: field.key, message: `${field.label} must be at most ${field.max}.` });
          }
        }
        break;
      }

      case 'checkbox':
        if (field.required && value !== true && value !== 'true') {
          errors.push({ field: field.key, message: `${field.label} must be ticked.` });
        }
        break;

      case 'select':
      case 'radio':
        if (field.options?.length && !field.options.some((o) => o.value === String(value))) {
          errors.push({ field: field.key, message: `${field.label} has an invalid selection.` });
        }
        break;

      case 'multiselect': {
        const values = Array.isArray(value) ? value : [value];
        if (field.options?.length) {
          const allowed = new Set(field.options.map((o) => o.value));
          if (values.some((v) => !allowed.has(String(v)))) {
            errors.push({ field: field.key, message: `${field.label} has an invalid selection.` });
          }
        }
        break;
      }

      default:
        break;
    }

    if (typeof value === 'string') {
      if (field.maxLength && value.length > field.maxLength) {
        errors.push({
          field: field.key,
          message: `${field.label} must be ${field.maxLength} characters or fewer.`,
        });
      }
      if (field.pattern && !new RegExp(field.pattern).test(value)) {
        errors.push({ field: field.key, message: `${field.label} is not in the expected format.` });
      }
    }
  }

  return errors;
}

/** Documents the schema marks required that the application has not supplied. */
export function missingDocuments(schema: FormSchema, uploadedKeys: string[]): FormDocument[] {
  const have = new Set(uploadedKeys);
  return (schema.documents ?? []).filter((d) => d.required && !have.has(d.key));
}

/** Required photos not yet captured. Photos share the documents table. */
export function missingPhotos(schema: FormSchema, capturedKeys: string[]): FormPhoto[] {
  const have = new Set(capturedKeys);
  return (schema.photos ?? []).filter((p) => p.required && !have.has(p.key));
}

/** Columns on `suppliers` that a form field is allowed to populate. */
const SUPPLIER_COLUMNS = new Set([
  'name', 'legal_name', 'trade_name', 'supplier_type', 'business_type', 'category',
  'tin', 'vat_status', 'business_permit_no', 'sec_dti_reg_no', 'bir_cor_no',
  'contact_person', 'contact_position', 'email', 'phone', 'mobile',
  'business_address', 'pickup_address', 'city', 'province', 'postal_code', 'country',
  // Remittance details. We are the payer, so the form has to collect these.
  'bank_name', 'bank_branch', 'bank_account_name', 'bank_account_no',
  'lead_time_days',
]);

/**
 * Turns submitted answers into a `suppliers` column patch, following each
 * field's `mapsTo`. Anything not on the allow-list above is ignored, so a
 * hand-edited form schema can never write to payment_terms_days, ewt_rate or status.
 */
export function mapToSupplier(schema: FormSchema, data: FormData): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  for (const field of allFields(schema)) {
    if (!field.mapsTo) continue;
    const [table, column] = field.mapsTo.split('.');
    if (table !== 'suppliers' || !SUPPLIER_COLUMNS.has(column)) continue;

    const value = data[field.key];
    if (isBlank(value)) continue;
    patch[column] = typeof value === 'string' ? value.trim() : value;
  }

  return patch;
}

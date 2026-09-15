'use client';

import type { FormField, FormSchema, FormData, ValidationError } from '@/lib/forms';
import { isVisible } from '@/lib/forms';

interface Props {
  schema: FormSchema;
  data: FormData;
  errors?: ValidationError[];
  disabled?: boolean;
  onChange: (key: string, value: unknown) => void;
}

/**
 * Renders a form from its schema. Every input is controlled and reports back
 * through one onChange, so the page owns all the state and can save drafts
 * without this component knowing anything about persistence.
 */
export default function FormRenderer({ schema, data, errors = [], disabled, onChange }: Props) {
  const errorFor = (key: string) => errors.find((e) => e.field === key)?.message;

  return (
    <div className="space-y-8">
      {schema.sections.map((section) => {
        const visibleFields = section.fields.filter((f) => isVisible(f, data));
        if (visibleFields.length === 0) return null;

        return (
          <section key={section.key} className="card p-6">
            <h2 className="text-lg font-semibold text-slate-900">{section.title}</h2>
            {section.description && (
              <p className="mt-1 text-sm text-slate-500">{section.description}</p>
            )}

            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              {visibleFields.map((field) => (
                <Field
                  key={field.key}
                  field={field}
                  value={data[field.key]}
                  error={errorFor(field.key)}
                  disabled={disabled}
                  onChange={onChange}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Field({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: FormField;
  value: unknown;
  error?: string;
  disabled?: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  // Full-width types get their own row; the rest sit two-up.
  const wide = ['textarea', 'section_note', 'multiselect'].includes(field.type);
  const id = `f_${field.key}`;
  const str = value === undefined || value === null ? '' : String(value);

  if (field.type === 'section_note') {
    return (
      <p className="sm:col-span-2 rounded-md bg-slate-50 p-4 text-sm text-slate-600">
        {field.label}
      </p>
    );
  }

  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      {field.type !== 'checkbox' && (
        <label htmlFor={id} className="label">
          {field.label}
          {field.required && <span className="ml-0.5 text-red-500">*</span>}
        </label>
      )}

      {renderControl()}

      {field.help && !error && <p className="mt-1 text-xs text-slate-500">{field.help}</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );

  function renderControl() {
    const common = {
      id,
      disabled,
      'aria-invalid': Boolean(error),
      className: `input ${error ? 'border-red-400 focus:border-red-500 focus:ring-red-500' : ''}`,
    };

    switch (field.type) {
      case 'textarea':
        return (
          <textarea
            {...common}
            rows={3}
            placeholder={field.placeholder}
            maxLength={field.maxLength}
            value={str}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
        );

      case 'select':
        return (
          <select {...common} value={str} onChange={(e) => onChange(field.key, e.target.value)}>
            <option value="">Select…</option>
            {field.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );

      case 'radio':
        return (
          <div className="space-y-2">
            {field.options?.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={field.key}
                  value={o.value}
                  checked={str === o.value}
                  disabled={disabled}
                  onChange={() => onChange(field.key, o.value)}
                  className="h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                {o.label}
              </label>
            ))}
          </div>
        );

      case 'multiselect': {
        const selected = Array.isArray(value) ? (value as string[]) : [];
        return (
          <div className="grid gap-2 sm:grid-cols-2">
            {field.options?.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(o.value)}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange(
                      field.key,
                      e.target.checked
                        ? [...selected, o.value]
                        : selected.filter((v) => v !== o.value),
                    )
                  }
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                {o.label}
              </label>
            ))}
          </div>
        );
      }

      case 'checkbox':
        return (
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              id={id}
              type="checkbox"
              checked={value === true || value === 'true'}
              disabled={disabled}
              onChange={(e) => onChange(field.key, e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            <span>
              {field.label}
              {field.required && <span className="ml-0.5 text-red-500">*</span>}
            </span>
          </label>
        );

      case 'number':
        return (
          <input
            {...common}
            type="number"
            placeholder={field.placeholder}
            min={field.min}
            max={field.max}
            value={str}
            onChange={(e) =>
              onChange(field.key, e.target.value === '' ? '' : Number(e.target.value))
            }
          />
        );

      case 'date':
        return (
          <input
            {...common}
            type="date"
            value={str}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
        );

      case 'url':
        return (
          <div>
            <input
              {...common}
              type="url"
              inputMode="url"
              placeholder={field.placeholder}
              value={str}
              onChange={(e) => onChange(field.key, e.target.value)}
            />
            {/* Let the applicant confirm the link points where they think. */}
            {str.startsWith('http') && (
              <a
                href={str}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block text-xs text-brand-600 hover:text-brand-700"
              >
                Open this link to check it ↗
              </a>
            )}
          </div>
        );

      default:
        return (
          <input
            {...common}
            type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'}
            placeholder={field.placeholder}
            maxLength={field.maxLength}
            value={str}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
        );
    }
  }
}

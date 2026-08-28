import { forwardRef, useId, type InputHTMLAttributes } from "react";
import "./FormField.css";

interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  errorMessage?: string;
  helpText?: string;
}

export const FormField = forwardRef<HTMLInputElement, FormFieldProps>(function FormField(
  { label, errorMessage, helpText, id, ...rest },
  ref
) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const helpId = helpText ? `${fieldId}-help` : undefined;
  const errorId = errorMessage ? `${fieldId}-error` : undefined;

  return (
    <div className="form-field">
      <label className="form-field__label" htmlFor={fieldId}>
        {label}
      </label>
      <input
        ref={ref}
        id={fieldId}
        className={`form-field__input${errorMessage ? " form-field__input--error" : ""}`}
        aria-invalid={Boolean(errorMessage) || undefined}
        aria-describedby={[helpId, errorId].filter(Boolean).join(" ") || undefined}
        {...rest}
      />
      {helpText && (
        <p id={helpId} className="form-field__help">
          {helpText}
        </p>
      )}
      {errorMessage && (
        <p id={errorId} className="form-field__error" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  );
});

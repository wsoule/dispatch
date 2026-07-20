import './TextInput.css';

type TextInputProps = React.InputHTMLAttributes<HTMLInputElement>;

export function TextInput({ className, ...rest }: TextInputProps) {
  const classes = ['text-input', className].filter(Boolean).join(' ');
  return <input className={classes} {...rest} />;
}

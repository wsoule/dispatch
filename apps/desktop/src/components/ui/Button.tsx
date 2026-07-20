import './Button.css';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

export function Button({
  variant = 'primary',
  className,
  ...rest
}: ButtonProps) {
  const classes = ['btn', `btn-${variant}`, className]
    .filter(Boolean)
    .join(' ');
  return <button className={classes} {...rest} />;
}

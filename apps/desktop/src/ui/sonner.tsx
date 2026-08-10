import { Toaster as Sonner, type ToasterProps } from 'sonner';

/** Theme follows the OS like the rest of the app; sonner's "system" does that
 * without next-themes. */
const Toaster = ({ ...props }: ToasterProps) => (
  <Sonner theme="system" className="toaster group" {...props} />
);

export { Toaster };

// CSS module imports: hosts (Next, Vite) generate the real class names; this
// declaration only lets TypeScript accept the import.
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
declare module '*.css';

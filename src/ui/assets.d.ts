/** Bun's bundler resolves asset imports to a URL string. */
declare module "*.svg" {
  const url: string;
  export default url;
}

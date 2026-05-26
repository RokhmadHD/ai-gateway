/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: require("path").join(__dirname, "../../"),
};

module.exports = nextConfig;

/** @type {import("next").NextConfig} */
const config = {
  redirects: async () => {
    return [
      {
        source: "/",
        destination: "/chapter-2-trailer",
        permanent: false,
      },
      {
        source: "/casino/:path*",
        destination: "/chapter-2-trailer",
        permanent: false,
      },
    ];
  },
};

export default config;

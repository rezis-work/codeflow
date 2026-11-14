export function middleware() {
  return null;
}

const dynamicMatcher = '/computed';

export const config = {
  matcher: ['/api/:path*', dynamicMatcher],
};

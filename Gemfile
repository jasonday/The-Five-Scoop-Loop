source "https://rubygems.org"

# Local preview and the GitHub Actions build use this Gemfile. (GitHub's native
# Pages builder runs its own pinned environment and ignores this file.)
#   bundle install
#   bundle exec jekyll serve
#
# We use modern Jekyll 4 rather than the github-pages gem, because that gem
# pins Jekyll 3.9 / Liquid 4.0.3, which call String#tainted? (removed in
# Ruby 3.2+) and break on current Ruby. The site uses no Pages-only plugins,
# so the built output is the same.
gem "jekyll", "~> 4.4"
gem "webrick", "~> 1.8"

# Windows and JRuby time zone data
gem "tzinfo-data", platforms: [:mingw, :mswin, :x64_mingw, :jruby]

# Standard-library gems that recent Rubies (3.4+/4.0) no longer bundle by
# default and that Jekyll's dependency chain still expects.
gem "csv"
gem "bigdecimal"
gem "base64"
gem "logger"

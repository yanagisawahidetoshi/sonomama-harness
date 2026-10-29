# Development / test image. Production images are out of scope for now.
FROM ruby:3.4.12-slim@sha256:caf086d19bf11fabd2af8bf33cb84007acc9655f31ea2cd129e754d05f374c27

RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y build-essential git libpq-dev libyaml-dev postgresql-client curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /rails

ENV BUNDLE_PATH=/usr/local/bundle

COPY Gemfile Gemfile.lock ./
RUN bundle install

COPY . .

EXPOSE 3000
CMD ["bin/rails", "server", "-b", "0.0.0.0", "-p", "3000"]

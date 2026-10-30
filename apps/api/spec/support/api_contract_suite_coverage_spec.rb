# frozen_string_literal: true

require "rails_helper"

RSpec.describe ApiContract do
  describe ".verify_suite_coverage" do
    context "when rspec runs without paths but a filter limits the examples" do
      it "fails, because the Verifier's full run must not silently check only part of the suite" do
        configuration = RSpec::Core::Configuration.new
        configuration.filter_run_including(focus: true)

        expect { described_class.verify_suite_coverage(configuration) }
          .to raise_error(ApiContract::CoverageError, /only part of the suite/)
      end
    end

    context "when a developer runs one spec file" do
      it "reports that coverage was not checked" do
        configuration = RSpec::Core::Configuration.new
        configuration.files_or_directories_to_run = ["spec/lib/route_manifest_spec.rb"]

        expect(described_class.verify_suite_coverage(configuration))
          .to contain_exactly(a_string_including("NOT CHECKED"))
      end
    end
  end
end

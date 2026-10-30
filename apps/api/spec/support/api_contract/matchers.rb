# frozen_string_literal: true

module ApiContract
  module Matchers
    extend RSpec::Matchers::DSL

    # expect(response).to match_api_contract                    the request and the response follow the SSOT contract
    # expect(response).to match_api_contract(request: :invalid) a negative spec: the request violates the contract
    #                                                          and the error response still follows it
    matcher :match_api_contract do |contract = nil, request: :valid|
      match do |response|
        subject_contract = contract || ApiContract.default
        @result = subject_contract.check(response.request, response)
        matched = problems.empty?
        # Coverage counts only a conforming request whose response followed the contract. A failed check or a negative
        # spec (request: :invalid) does not show that the route serves the contract.
        ApiContract.record(subject_contract, @result.operation) if matched && request == :valid
        matched
      end

      define_method(:problems) do
        return ["#{@result.operation} is not defined in the contract"] if @result.undefined
        return @result.request_violations + @result.response_violations unless request == :invalid

        detected = @result.request_violations.any? ? [] : ["request conforms, but the spec declared request: :invalid"]
        detected + @result.response_violations
      end

      failure_message do
        "API contract violation in #{@result.operation} -> #{@result.status}:\n#{problems.join("\n").indent(2)}"
      end
    end
  end
end

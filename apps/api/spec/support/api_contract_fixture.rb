# frozen_string_literal: true

# A Rails app used only by spec/support/api_contract_spec.rb. It serves spec/fixtures/api_contract/students.yaml through
# real Rails controllers and its own route set, so the product routes (config/routes.rb) never get a test endpoint.
# Each action deliberately returns one kind of response; the specs pick the action by drawing the route to it.
module ApiContractFixture
  CONTRACT_DIR = Rails.root.join("spec/fixtures/api_contract")

  STUDENT = {
    studentId: "s-1", name: "Taro", status: "active", nickname: nil, guardianEmail: "guardian@example.com",
    tags: ["new"], profile: { grade: 3 }
  }.freeze

  class StudentsController < ActionController::API
    def show = render(json: STUDENT)
    def numeric_student_id = render(json: STUDENT.merge(studentId: 1))
    def missing_name = render(json: STUDENT.except(:name))
    def null_name = render(json: STUDENT.merge(name: nil))
    def invalid_status = render(json: STUDENT.merge(status: "graduated"))
    def missing_defaulted_status = render(json: STUDENT.except(:status))
    def numeric_tag = render(json: STUDENT.merge(tags: ["new", 2]))
    def missing_nested_grade = render(json: STUDENT.merge(profile: {}))
    def extra_property = render(json: STUDENT.merge(classroom: "1-A"))
    def invalid_guardian_email = render(json: STUDENT.merge(guardianEmail: "guardian-at-example"))
    def undeclared_status = render(json: STUDENT, status: :conflict)
    def plain_text = render(plain: "Taro", status: :ok)
    def not_found = render(json: { error: { code: "not_found", message: "Student not found" } }, status: :not_found)
    def malformed_not_found = render(json: { message: "Student not found" }, status: :not_found)

    def index = render(json: { students: [STUDENT] })
    def index_with_extra_property = render(json: { students: [STUDENT], total: 1 })

    def create
      if valid_input?
        return render(json: STUDENT.merge(name: params[:name]), status: :created,
                      location: "/students/s-1")
      end

      render json: { error: { code: "invalid_request", message: "name and grade are required" } }, status: :bad_request
    end

    def create_accepting_invalid_input = render(json: STUDENT, status: :created, location: "/students/s-1")
    def create_without_location = render(json: STUDENT, status: :created)
    def create_with_malformed_error = render(json: { errors: ["invalid"] }, status: :bad_request)
    def destroy = head(:no_content)

    def archive
      response.headers["Location"] = "/students/s-1"
      head(:accepted)
    end

    def archive_without_location = head(:accepted)
    def archive_with_body = render(json: { archived: true }, status: :accepted, location: "/students/s-1")

    private

    def valid_input?
      params[:name].is_a?(String) && params[:grade].is_a?(Integer)
    end
  end

  ROUTES = {
    show: [:get, "/students/:id"], index: [:get, "/students"], create: [:post, "/students"],
    destroy: [:delete, "/students/:id"], archive: [:post, "/students/:id/archive"]
  }.freeze

  module_function

  def contract_path(name = "students")
    CONTRACT_DIR.join("#{name}.yaml")
  end

  # Routes every fixture operation to its conforming action, except the operations listed in actions.
  # Example: app(show: :numeric_student_id) answers GET /students/:id with a numeric studentId.
  def app(**actions)
    routes = ActionDispatch::Routing::RouteSet.new
    routes.draw do
      ROUTES.each do |operation, (verb, path)|
        public_send(verb, path, to: "api_contract_fixture/students##{actions.fetch(operation, operation)}")
      end
    end
    routes
  end
end

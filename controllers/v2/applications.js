const driver = require('../../neo4j_driver.js')

const visibility_enforcement = `
  WITH user, application
  WHERE NOT application.private
    OR NOT EXISTS(application.private)
    OR (application)-[:SUBMITTED_BY]->(user)
    OR (application)-[:SUBMITTED_TO]->(user)
    OR (application)-[:VISIBLE_TO]->(:Group)<-[:BELONGS_TO]-(user)
`

function get_current_user_id(res) {
  return res.locals.user.identity.low
    ?? res.locals.user.identity
}

function get_application_id(req) {
  return req.params.application_id
    ?? req.body.application_id
    ?? req.body.id
    ?? req.query.application_id
    ?? req.query.id
}

function format_application_from_record(record) {
  return {
    ...record.get('application'),
    applicant: {
      ...record.get('applicant'),
      authorship: record.get('authorship')
    },
    visibility: record.get('visibility'),
    recipients: record.get('recipients')
      .map(recipient => ({
        ...recipient,
        submission: record.get('submissions').find(submission => submission.end === recipient.identity ),
        approval: record.get('approvals').find(approval =>   approval.start === recipient.identity ),
        refusal: record.get('refusals').find(refusal => refusal.start === recipient.identity ),
      }))
      .sort( (a,b) => a.submission.properties.flow_index - b.submission.properties.flow_index )
  }
}

exports.get_application = (req, res) => {
  // Get a single application using its ID

  const application_id = get_application_id(req)
  if(!application_id) return res.status(400).send('Application ID not defined')

  const session = driver.session()
  session.run(`
    // Find current user to check for authorization
    MATCH (user:User)
    WHERE id(user)=toInteger($user_id)

    // Find application and applicant
    WITH user
    MATCH (application:ApplicationForm)
    WHERE id(application) = toInteger($application_id)

    // Dealing with confidentiality
    WITH application,
      application.private
      AND NOT (application)-[:SUBMITTED_BY]->(user)
      AND NOT (application)-[:SUBMITTED_TO]->(user)
      AND NOT (application)-[:VISIBLE_TO]->(:Group)<-[:BELONGS_TO]-(user)
    AS forbidden

    // Find applicant
    WITH application, forbidden
    OPTIONAL MATCH (application)-[authorship:SUBMITTED_BY]->(applicant:User)

    // Find recipients
    WITH application, applicant, authorship, forbidden
    OPTIONAL MATCH (application)-[submission:SUBMITTED_TO]->(recipient:User)

    // Find approvals
    WITH application, applicant, authorship, recipient, submission, forbidden
    OPTIONAL MATCH (application)<-[approval:APPROVED]-(recipient)

    // Find rejections
    WITH application, applicant, authorship, recipient, submission, approval, forbidden
    OPTIONAL MATCH (application)<-[refusal:REJECTED]-(recipient)

    // visibility
    WITH application, applicant, authorship, recipient, submission, approval, refusal, forbidden
    OPTIONAL MATCH (application)-[:VISIBLE_TO]->(group:Group)
      WHERE application.private = true

    // Return everything
    RETURN application,
      applicant,
      authorship,
      collect(distinct recipient) as recipients,
      collect(distinct submission) as submissions,
      collect(distinct approval) as approvals,
      collect(distinct refusal) as refusals,
      collect(distinct group) as visibility,
      forbidden
    `, {
    user_id: get_current_user_id(res),
    application_id,
  })
  .then( ({records}) => {

    if(records.length < 1) {
      console.log(`Application ${application_id} not found`)
      return res.status(404).send(`Application ${application_id} not found`)
    }

    const record = records[0]

    if(record.get('forbidden')) {
      let application = record.get('application')
      delete application.properties.form_data
      application.properties.title = '機密 / Confidential'
    }

    const application = format_application_from_record(record)

    res.send(application)
  })
  .catch(error => {
    console.log(error)
    res.status(500).send(`Error accessing DB: ${error}`)
  })
  .finally(() => { session.close() })
}


exports.get_submitted_applications_pending = (req, res) => {

  // INCOMPLETE: NEED TO RETURN RECIPIENTS, APPROVALS ETC


  const query = `
  // Get applications of applicant
  MATCH (applicant:User)<-[:SUBMITTED_BY]-(application:ApplicationForm)
  WHERE id(applicant)=toInteger($user_id)

  // Filter out rejects
  WITH application, applicant
  WHERE NOT (:User)-[:REJECTED]->(application)

  // Get submission_count and approval_count
  // In order to filter out completed applications
  WITH application, applicant
  MATCH (application)-[:SUBMITTED_TO]->(recipient:User)
  WITH application, applicant, COUNT(recipient) AS recipient_count
  OPTIONAL MATCH (:User)-[approval:APPROVED]->(application)
  WITH application, applicant, recipient_count, count(approval) as approval_count
  WHERE NOT recipient_count = approval_count

  RETURN application
  `

  const params = {
    user_id: get_current_user_id(res),
  }

  const session = driver.session()

  session.run(query, params)
  .then( ({records}) => {

    const applications = records.map(record => record.get('application'))

    res.send(applications)

  })
  .catch(error => {
    console.log(error)
    res.status(500).send(`Error accessing DB: ${error}`) })
  .finally(() => { session.close() })

}

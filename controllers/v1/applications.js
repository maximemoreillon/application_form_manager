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

exports.create_application = (req, res) => {
  // Route to create or edit an application

  var session = driver.session();
  session
  .run(`
    // Create the application node
    MATCH (s:User)
    WHERE id(s)=toInteger($user_id)
    CREATE (application:ApplicationForm)-[:SUBMITTED_BY {date: date()} ]->(s)

    // Set the application properties using data passed in the requestr body
    SET application.creation_date = date()
    SET application.title = $title
    SET application.private = $private
    SET application.form_data = $form_data
    SET application.type = $type

    // Relationship with recipients
    // This also creates flow indices
    // Note: flow cannot be empty
    WITH application, $recipients_ids as recipients_ids
    UNWIND range(0, size(recipients_ids)-1) as i
    MATCH (r:User)
    WHERE id(r)=toInteger(recipients_ids[i])
    CREATE (r)<-[:SUBMITTED_TO {date: date(), flow_index: i} ]-(application)

    // Groups to which the aplication is visible
    // Note: can be an empty set so the logic to deal with it looks terrible
    WITH application
    UNWIND
      CASE
        WHEN $group_ids = []
          THEN [null]
        ELSE $group_ids
      END AS group_id

    OPTIONAL MATCH (group:Group)
    WHERE id(group) = toInteger(group_id)
    WITH collect(group) as groups, application
    FOREACH(group IN groups | MERGE (application)-[:VISIBLE_TO]->(group))

    // Finally, Return the application
    RETURN application
    `, {
    user_id: get_current_user_id(res),
    // Stuff from the body
    type: req.body.type,
    title: req.body.title,
    form_data: JSON.stringify(req.body.form_data), // Neo4J does not support nested props so convert to string
    recipients_ids: req.body.recipients_ids, // Manadatory
    private: req.body.private || false,
    group_ids: req.body.group_ids || [],
  })
  .then( ({records}) => {
    if(records.length < 1) return res.status(500).send(`Failed to create application`)
    const application = records[0].get('application')
    console.log(`Application ${application.identity} created`)
    res.send(application)
  })
  .catch(error => {
    console.log(error)
    res.status(500).send(`Error accessing DB: ${error}`)
  })
  .finally(() => { session.close() })
}

exports.delete_application = (req, res) => {
  // Deleting an application
  // Only the creator can delete the application

  const application_id = get_application_id(req)

  if(!application_id) return res.status(400).send('Application ID not defined')

  var session = driver.session()
  session
  .run(`
    // Find the application to be deleted using provided id
    MATCH (applicant:User)<-[:SUBMITTED_BY]-(application:ApplicationForm)
    WHERE id(application) = toInteger($application_id)
      AND id(applicant)=toInteger($user_id)

    // Delete the application and all of its relationships
    DETACH DELETE application

    RETURN 'OK'
    `, {
    user_id: get_current_user_id(res),
    application_id: application_id,
  })
  .then(({records}) => {

    if(records.length < 1) {
      console.log(`Application ${application_id} not found`)
      return res.status(404).send(`Application ${application_id} not found`)
    }
    res.send(`Application ${application_id} deleted`)
    console.log(`Application ${application_id} deleted`)
  })
  .catch(error => {
    console.log(error)
    res.status(500).send(`Error accessing DB: ${error}`)
  })
  .finally(() => { session.close() })
}

exports.get_application = (req, res) => {
  // Get a single application using its ID

  const application_id = get_application_id(req)
  if(!application_id) return res.status(400).send('Application ID not defined')

  var session = driver.session()
  session
  .run(`
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
    OPTIONAL MATCH (application)-[submitted_by:SUBMITTED_BY]->(applicant:User)

    // Find recipients
    WITH application, applicant, submitted_by, forbidden
    OPTIONAL MATCH (application)-[submitted_to:SUBMITTED_TO]->(recipient:User)

    // Find approvals
    WITH application, applicant, submitted_by, recipient, submitted_to, forbidden
    OPTIONAL MATCH (application)<-[approval:APPROVED]-(recipient)

    // Find rejections
    WITH application, applicant, submitted_by, recipient, submitted_to, approval, forbidden
    OPTIONAL MATCH (application)<-[rejection:REJECTED]-(recipient)

    WITH application, applicant, submitted_by, recipient, submitted_to, approval, rejection, forbidden
    OPTIONAL MATCH (application)-[:VISIBLE_TO]->(group:Group)

    // Return everything
    RETURN application,
      applicant,
      submitted_by,
      collect(distinct recipient) as recipients,
      collect(distinct submitted_to) as submissions,
      collect(distinct approval) as approvals,
      collect(distinct rejection) as rejections,
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

    // There should only be one record
    let record = records[0]

    // Remove sensitive information
    if(record.get('forbidden')) {
      let application = record.get('application')
      delete application.properties.form_data
      application.properties.title = '機密 / Confidential'
    }

    res.send(record)
  })
  .catch(error => {
    console.log(error)
    res.status(500).send(`Error accessing DB: ${error}`)
  })
  .finally(() => { session.close() })
}


exports.get_application_v2 = (req, res) => {
  // Is this even used?

  // Get a single application using its ID

  const application_id = get_application_id(req)
  if(!application_id) return res.status(400).send('Application ID not defined')

  var session = driver.session()
  session
  .run(`
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

    const application = {
      ...record.get('application'),
      applicant: {
        ...record.get('applicant'),
        authorship: record.get('authorship')
      },
      visibility: record.get('visibility'),
    }

    application.recipients = record.get('recipients')
    .map(recipient => {
      return {
        ...recipient,
        submission: record.get('submissions').find(submission => submission.end === recipient.identity ),
        approval: record.get('approvals').find(approval =>   approval.start === recipient.identity ),
        refusal: record.get('refusals').find(refusal => refusal.start === recipient.identity ),
      }
    })
    // Sort by flow index
    .sort( (a,b) => {
      return a.submission.properties.flow_index - b.submission.properties.flow_index
    })

    res.send(application)
  })
  .catch(error => {
    console.log(error)
    res.status(500).send(`Error accessing DB: ${error}`)
  })
  .finally(() => { session.close() })
}


exports.search_applications = (req, res) => {
  // Get a list of applications matching a certain search pattern

  /*
  Queries:
    - ID
    - Hanko ID
    - Type
    - Date
    - Relationship type
    - approval state
    - group of applicant
  */

  // Todo: batching/pagination


  let relationship_query = ''
  let relationship_types = ['APPROVED', 'REJECTED', 'SUBMITTED_BY', 'SUBMITTED_TO']
  let relationship_type = req.query.relationship_type
  if (relationship_type && !relationship_types.includes(relationship_type)) return res.status(400).send(`Invalid relationship type`)
  if(relationship_type) {
    relationship_query = `
    WITH application, user
    MATCH (application)-[r]-(user)
    WHERE type(r) = $relationship_type
      AND id(user) = toInteger($user_id)
    `
  }

  let hanko_id_query = ''
  if(req.query.hanko_id && req.query.hanko_id !== '') {
    hanko_id_query = `
    WITH application
    MATCH (application)-[r:APPROVED]-(:User)
    WHERE id(r) = toInteger($hanko_id)
    `
  }

  let application_id_query = ''
  if(req.query.application_id && req.query.application_id !== '') {
    application_id_query = `
    WITH application
    WHERE id(application) = toInteger($application_id)
    `
  }

  let start_date_query = ''
  if(req.query.start_date && req.query.start_date !== '') {
    start_date_query = `
    WITH application
    WHERE application.creation_date >= date($start_date)
    `
  }

  let end_date_query = ''
  if(req.query.end_date && req.query.end_date !== '') {
    end_date_query = `
    WITH application
    WHERE application.creation_date <= date($end_date)
    `
  }

  let type_query = ''
  if(req.query.application_type && req.query.application_type !== '') {
    type_query = `
    WITH application
    WHERE toLower(application.type) CONTAINS toLower($application_type)
    `
  }

  let group_query = ''
  if(req.query.group_id && req.query.group_id !== '') {
    group_query = `
    WITH application
    MATCH (application)-[:SUBMITTED_BY]->(:User)-[:BELONGS_TO]->(group:Group)
    WHERE id(group) = toInteger($group_id)
    `
  }

  let approval_state_query = ''
  if(req.query.approval_state === 'approved') {
    approval_state_query = `
    WITH application
    MATCH (application)-[:SUBMITTED_TO]->(recipient:User)
    WITH application, COUNT(recipient) AS recipient_count
    OPTIONAL MATCH (:User)-[approval:APPROVED]->(application)
    WITH application, recipient_count, count(approval) as approval_count

    // Filter in completed applications
    WITH application, recipient_count, approval_count
    WHERE recipient_count = approval_count
    `
  }

  var session = driver.session()
  session
  .run(`
    // Find current user
    MATCH (user:User)
    WHERE id(user)=toInteger($user_id)

    WITH user
    MATCH (application:ApplicationForm)

    ${relationship_query}
    ${start_date_query}
    ${end_date_query}
    ${application_id_query}
    ${hanko_id_query}
    ${type_query}
    ${group_query}
    ${approval_state_query}

    // Manage confidentiality
    WITH application
    MATCH (application)-[:SUBMITTED_BY]->(applicant:User)
    WITH application, applicant
    MATCH (user:User)
    WHERE id(user)=toInteger($user_id)
    WITH application, applicant,
      application.private
      AND NOT (application)-[:SUBMITTED_BY]->(user)
      AND NOT (application)-[:SUBMITTED_TO]->(user)
      AND NOT (application)-[:VISIBLE_TO]->(:Group)<-[:BELONGS_TO]-(user)
    AS forbidden

    // Return the application
    RETURN application, applicant, forbidden

    // Sorting by date
    ORDER BY application.creation_date DESC

    // Limit
    LIMIT 200
    `, {
    user_id: get_current_user_id(res),
    application_id: req.query.application_id,
    application_type: req.query.application_type,
    relationship_type: relationship_type,
    hanko_id: req.query.hanko_id,
    start_date: req.query.start_date,
    end_date: req.query.end_date,
    group_id: req.query.group_id,
  })
  .then(({records}) => {

    // Remove sensitive information
    records.forEach((record) => {
      if(record.get('forbidden')) {
        let application_node = record.get('application')
        delete application_node.properties.form_data
        application_node.properties.title = '機密 / Confidential'
      }
    })

    res.send(records)
  })
  .catch(error => {
    console.log(error)
    res.status(500).send(`Error accessing DB: ${error}`)
  })
  .finally(() => { session.close() })
}

exports.get_application_count = (req, res) => {

  var session = driver.session()
  session
  .run(`
    // Find applications
    MATCH (application:ApplicationForm)

    // Return the application count
    RETURN count(application) as application_count

    `, {})
  .then( ({records}) => {
    res.send({ application_count: records[0].get('application_count') })
  })
  .catch(error => {
    console.log(error)
    res.status(500).send(`Error accessing DB: ${error}`)
  })
  .finally(() => { session.close() })
}

exports.get_application_types = (req, res) => {

  // Used for search

  var session = driver.session()
  session
  .run(`
    // Find applications
    MATCH (application:ApplicationForm)

    // Return the application count
    RETURN distinct(application.type) as application_type

    `, {})
  .then( ({records}) => {
    res.send(records.map(record => record.get('application_type')))
  })
  .catch(error => {
    console.log(error)
    res.status(500).send(`Error accessing DB: ${error}`)
  })
  .finally(() => { session.close() })
}



exports.get_application_visibility = (req, res) => {
  // Get a the groups an application is visible to

  // Actually used!
  // WHERE? WHY?
  let application_id = get_application_id(req)

  if(!application_id) return res.status(400).send('Application ID not defined')

  var session = driver.session()
  session
  .run(`
    // Find current user to check for authorization
    MATCH (user:User)
    WHERE id(user)=toInteger($user_id)

    // Find application and applicant
    WITH user
    MATCH (application:ApplicationForm)
    WHERE id(application) = toInteger($application_id)

    // Enforce privacy
    // REMOVED

    // Find groups the application is visible to
    WITH application
    MATCH (application)-[:VISIBLE_TO]->(group:Group)

    // Return
    RETURN group

    `, {
    user_id: get_current_user_id(res),
    application_id: application_id,
  })
  .then(result => { res.send(result.records) })
  .catch(error => {
    console.log(error)
    res.status(500).send(`Error accessing DB: ${error}`)
  })
  .finally(() => { session.close() })
}

exports.approve_application = (req, res) => {

  // TODO: prevent re-approval

  let application_id = get_application_id(req)

  if(!application_id) return res.status(400).send('Application ID not defined')

  let attachment_hankos_query = ``
  if(req.body.attachment_hankos) {
    attachment_hankos_query = `SET approval.attachment_hankos = $attachment_hankos`
  }


  var session = driver.session()
  session
  .run(`
    // Find the application and get oneself at the same time
    MATCH (application:ApplicationForm)-[submission:SUBMITTED_TO]->(recipient:User)
    WHERE id(application) = toInteger($application_id)
      AND id(recipient) = toInteger($user_id)

    // TODO: Add check if flow is respected

    // Mark as approved
    WITH application, recipient
    MERGE (application)<-[approval:APPROVED]-(recipient)
    SET approval.date = date()
    SET approval.comment = $comment
    ${attachment_hankos_query}

    RETURN approval, recipient, application
    `, {
    user_id: get_current_user_id(res),
    application_id,
    comment: req.body.comment || '',
    attachment_hankos: JSON.stringify(req.body.attachment_hankos), // Neo4J does not support nested props so convert to string
  })
  .then(({records}) => {
    if(records.loength < 1) return res.status(404).send(`Application not found`)
    res.send(records[0].get('approval'))
    console.log(`Application ${records[0].get('application').identity} got approved by user ${records[0].get('recipient').identity}`)
  })
  .catch(error => {
    res.status(500).send(`Error accessing DB: ${error}`)
    console.log(error)
  })
  .finally(() => { session.close() })

}

exports.reject_application = (req, res) => {
  // basically the opposite of putting a hanko

  let application_id = get_application_id(req)

  if(!application_id) return res.status(400).send('Application ID not defined')

  const comment =  req.body.comment || ''

  var session = driver.session()
  session
  .run(`
    // Find the application and get oneself at the same time
    MATCH (application:ApplicationForm)-[submission:SUBMITTED_TO]->(recipient:User)
    WHERE id(application) = toInteger($application_id)
      AND id(recipient) = toInteger($user_id)

    // TODO: Add check if flow is respected
    // Working fine without apparently

    // Mark as REJECTED
    WITH application, recipient
    MERGE (application)<-[rejection:REJECTED]-(recipient)
    SET rejection.date = date()
    SET rejection.comment = $comment

    // RETURN APPLICATION
    RETURN application, recipient, rejection`, {
    user_id: get_current_user_id(res),
    application_id,
    comment,
  })
  .then(({records}) => {
    if(records.loength < 1) return res.status(404).send(`Application not found`)
    res.send(records[0].get('rejection'))
    console.log(`Application ${records[0].get('application').identity} got rejected by user ${records[0].get('recipient').identity}`)
  })
  .catch(error => {
    console.error(error)
    res.status(500).send(`Error accessing DB: ${error}`)
  })
  .finally(() => { session.close() })

}

exports.update_privacy_of_application = (req, res) => {
  // Riute to make an application confidential or public

  let application_id = get_application_id(req)

  if(!application_id) return res.status(400).send('Application ID not defined')

  var session = driver.session()
  session
  .run(`
    // Find the application
    MATCH (application:ApplicationForm)-[:SUBMITTED_BY]->(s)
    WHERE id(application)=toInteger($application_id)
      AND id(s)=toInteger($user_id)

    // Set the privacy property
    SET application.private = $private

    // Return the application
    RETURN application

    `, {
    user_id: get_current_user_id(res),
    application_id,
    private: req.body.private,
  })
  .then(({records}) => {
    if(records.length < 1) return res.status(404).send(`Application ${application_id} not found`)
    res.send(records[0].get('application'))
   })
  .catch(error => { res.status(500).send(`Error accessing DB: ${error}`) })
  .finally(() => { session.close() })

}

exports.update_application_visibility = (req, res) => {
  // Deletes all relationships to groups and recreate them

  const application_id = get_application_id(req)

  if(!application_id) return res.status(400).send('Application ID not defined')

  var session = driver.session();
  session
  .run(`
    // Find the application
    // Only the applicant can make the update
    MATCH (application:ApplicationForm)-[:SUBMITTED_BY]->(user)
    WHERE id(application)=toInteger($application_id)
      AND id(user)=toInteger($user_id)

    // delete all visibility relationships
    WITH application
    MATCH (application)-[rel:VISIBLE_TO]->(:Group)
    DELETE rel

    // Now recreate all relationships
    WITH application
    UNWIND
      CASE
        WHEN $group_ids = []
          THEN [null]
        ELSE $group_ids
      END AS group_id

    OPTIONAL MATCH (group:Group)
    WHERE id(group) = toInteger(group_id)
    WITH collect(group) as groups, application
    FOREACH(group IN groups | MERGE (application)-[:VISIBLE_TO]->(group))

    // Return the application
    RETURN application, group
    `, {
    user_id: get_current_user_id(res),
    application_id,
    group_ids: req.body.group_ids,
  })
  .then(({records}) => {
    if(records.length < 1) return res.status(404).send(`Application ${application_id} not found`)
    res.send(records[0].get('application'))
   })
  .catch(error => { res.status(500).send(`Error accessing DB: ${error}`) })
  .finally(() => { session.close() })
}


exports.make_application_visible_to_group = (req, res) => {
  // Deletes all relationships to groups and recreate them

  const application_id = get_application_id(req)

  if(!application_id) return res.status(400).send('Application ID not defined')

  var session = driver.session();
  session
  .run(`
    // Find the application
    // Only the applicant can make the update
    MATCH (application:ApplicationForm)-[:SUBMITTED_BY]->(user)
    WHERE id(application)=toInteger($application_id)
      AND id(user)=toInteger($user_id)

    // Find the group
    WITH application
    MATCH (group:Group)
    WHERE id(group)=toInteger($group_id)

    // Create the application
    MERGE (application)-[:VISIBLE_TO]->(group)

    // Return the application
    RETURN application, group
    `, {
    user_id: get_current_user_id(res),
    application_id,
    group_id: req.body.group_id,
  })
  .then(({records}) => {
    if(records.length < 1) return res.status(404).send(`Application ${application_id} not found`)
    res.send(records[0].get('application'))
   })
  .catch(error => { res.status(500).send(`Error accessing DB: ${error}`) })
  .finally(() => { session.close() })
}

exports.remove_application_visibility_to_group = (req, res) => {
  // Deletes all relationships to groups and recreate them

  const application_id = get_application_id(req)

  if(!application_id) return res.status(400).send('Application ID not defined')

  var session = driver.session();
  session
  .run(`
    // Find the application
    // Only the applicant can make the update
    MATCH (application:ApplicationForm)-[:SUBMITTED_BY]->(user)
    WHERE id(application)=toInteger($application_id)
      AND id(user)=toInteger($user_id)

    // Find the group
    WITH application
    MATCH (application)-[rel:VISIBLE_TO]->(group)
    WHERE id(group)=toInteger($group_id)

    // delete the relationship
    DELETE rel

    // Return the application
    RETURN application
    `, {
    user_id: get_current_user_id(res),
    application_id,
    group_id: req.query.group_id,
  })
  .then(({records}) => {
    if(records.length < 1) return res.status(404).send(`Application ${application_id} not found`)
    res.send(records[0].get('application'))
   })
  .catch(error => { res.status(500).send(`Error accessing DB: ${error}`) })
  .finally(() => { session.close() })
}


exports.get_submitted_applications = (req, res) => {
  // Get all applications submitted by the logged in user

  // UNUSED

  var session = driver.session()
  session
  .run(`
    MATCH (applicant:User)<-[:SUBMITTED_BY]-(application:ApplicationForm)
    WHERE id(applicant)=toInteger($user_id)

    RETURN application
    ORDER BY application.creation_date DESC
    `, {
    user_id: get_current_user_id(res),
  })
  .then(result => { res.send(result.records) })
  .catch(error => { res.status(500).send(`Error accessing DB: ${error}`) })
  .finally(() => { session.close() })

}

exports.get_submitted_applications_pending = (req, res) => {

  // TODO: Batching

  let query = `
  // Get applications of applicant
  MATCH (applicant:User)<-[:SUBMITTED_BY]-(application:ApplicationForm)
  WHERE id(applicant)=toInteger($user_id)

  // Filter out rejects
  WITH application, applicant
  WHERE NOT (:User)-[:REJECTED]->(application)

  // Get submission_count and approval_count
  WITH application, applicant
  MATCH (application)-[:SUBMITTED_TO]->(recipient:User)
  WITH application, applicant, COUNT(recipient) AS recipient_count
  OPTIONAL MATCH (:User)-[approval:APPROVED]->(application)
  WITH application, applicant, recipient_count, count(approval) as approval_count

  // Filter out completed applications
  WITH application, applicant, recipient_count, approval_count
  WHERE NOT recipient_count = approval_count

  // Find next recipient
  WITH application, applicant, recipient_count, approval_count
  MATCH (application)-[submission:SUBMITTED_TO]->(next_recipient:User)
  WHERE submission.flow_index = approval_count

  RETURN application, recipient_count, approval_count, next_recipient
  ORDER BY application.creation_date DESC
  `

  var session = driver.session()
  session
  .run(query, {
    user_id: get_current_user_id(res),
  })
  .then(result => {res.send(result.records)})
  .catch(error => {
    console.log(error)
    res.status(500).send(`Error accessing DB: ${error}`) })
  .finally(() => { session.close() })

}

exports.get_submitted_applications_approved = (req, res) => {

  let start_index = req.query.start_index || 0
  let batch_size = req.query.batch_size || 10

  let query = `
  // Get applications of applicant
  MATCH (applicant:User)<-[:SUBMITTED_BY]-(application:ApplicationForm)
  WHERE id(applicant)=toInteger($user_id)

  // Filter out rejects
  WITH application, applicant
  WHERE NOT (:User)-[:REJECTED]->(application)

  // Get submission_count and approval_count
  WITH application, applicant
  MATCH (application)-[:SUBMITTED_TO]->(recipient:User)
  WITH application, applicant, COUNT(recipient) AS recipient_count
  OPTIONAL MATCH (:User)-[approval:APPROVED]->(application)
  WITH application, applicant, recipient_count, count(approval) as approval_count

  // Filter in completed applications
  WITH application, applicant, recipient_count, approval_count
  WHERE recipient_count = approval_count

  // Batching
  WITH collect(application) AS application_collection
  WITH application_collection[toInteger($start_index)..toInteger($start_index)+toInteger($batch_size)] AS application_batch
  UNWIND application_batch AS application

  // here no need to return the counts as it is necessarily the number of recipients
  RETURN application
  ORDER BY application.creation_date DESC
  `

  var session = driver.session()
  session
  .run(query, {
    user_id: get_current_user_id(res),
    start_index: start_index,
    batch_size: batch_size,

  })
  .then(result => {
    res.send(result.records)
  })
  .catch(error => {
    console.log(error)
    res.status(500).send(`Error accessing DB: ${error}`)
  })
  .finally(() => { session.close() })
}


exports.get_submitted_applications_rejected = (req, res) => {

  const query = `
  // Get applications of applicant
  MATCH (applicant:User)<-[:SUBMITTED_BY]-(application:ApplicationForm)
  WHERE id(applicant)=toInteger($user_id)

  // Filter so as to get only rejected applications
  WITH application, applicant
  WHERE (:User)-[:REJECTED]->(application)

  // Get submission_count and approval_count
  WITH application, applicant
  MATCH (application)-[:SUBMITTED_TO]->(recipient:User)
  WITH application, applicant, COUNT(recipient) AS recipient_count
  OPTIONAL MATCH (:User)-[approval:APPROVED]->(application)
  WITH application, applicant, recipient_count, count(approval) as approval_count

  // Find next recipient (recipient who rejected the application)
  WITH application, applicant, recipient_count, approval_count
  MATCH (application)-[submission:SUBMITTED_TO]->(next_recipient:User)
  WHERE submission.flow_index = approval_count

  RETURN application, recipient_count, approval_count, next_recipient
  ORDER BY application.creation_date DESC
  `

  var session = driver.session()
  session.run(query, { user_id: get_current_user_id(res) })
  .then(({records}) => {
    res.send(records)
  })
  .catch(error => { res.status(500).send(`Error accessing DB: ${error}`) })
  .finally(() => { session.close() })

}


exports.get_received_applications = (req, res) => {
  // Returns applications rceived by the logged in user

  // UNUSED

  var session = driver.session()
  session
  .run(`
    // Get applications submitted to logged user
    MATCH (application:ApplicationForm)-[submission:SUBMITTED_TO]->(recipient:User)
    WHERE id(recipient)=toInteger($user_id)

    // Return
    RETURN application
    ORDER BY application.creation_date DESC
    `, {
      user_id: get_current_user_id(res),
  })
  .then( ({records}) => {   res.send(records) })
  .catch(error => { res.status(500).send(`Error accessing DB: ${error}`) })
  .finally(() => { session.close() })

}

exports.get_received_applications_pending = (req, res) => {
  // Returns applications submitted to a user but not yet approved
  var session = driver.session()
  session
  .run(`
    // Get applications submitted to logged user
    // The application must be neither approved nor rejected by the recpient
    MATCH (applicant:User)<-[:SUBMITTED_BY]-(application:ApplicationForm)-[submission:SUBMITTED_TO]->(recipient:User)
    WHERE id(recipient)=toInteger($user_id)
      AND NOT (application)<-[:APPROVED]-(recipient)
      AND NOT (application)<-[:REJECTED]-(recipient)

    // Check if recipient is next in the flow
    WITH application, recipient, submission, applicant
    OPTIONAL MATCH (application)<-[approval:APPROVED]-(:User)
    WITH submission, application, applicant, count(approval) as approvalCount
    WHERE submission.flow_index = approvalCount

    // Return
    RETURN application, applicant
    ORDER BY application.creation_date DESC
    `, {
      user_id: get_current_user_id(res),
  })
  .then((result) => {
    res.send(result.records)
  })
  .catch(error => { res.status(500).send(`Error accessing DB: ${error}`) })
  .finally(() => { session.close() })

}


exports.get_received_applications_approved = (req, res) => {
  // Returns applications approved by a user

  const start_index = req.query.start_index || 0
  const batch_size = req.query.batch_size || 10

  var session = driver.session()
  session
  .run(`
    // Get applications submitted to logged user
    MATCH (applicant)<-[:SUBMITTED_BY]-(application:ApplicationForm)<-[:APPROVED]-(recipient:User)
    WHERE id(recipient)=toInteger($user_id)

    // Batching
    WITH collect(application) AS application_collection, applicant
    WITH application_collection[toInteger($start_index)..toInteger($start_index)+toInteger($batch_size)] AS application_batch, applicant
    UNWIND application_batch AS application

    // Return
    RETURN application, applicant
    ORDER BY application.creation_date DESC`, {
      user_id: get_current_user_id(res),
      start_index,
      batch_size,
  })
  .then( ({records}) => {
    res.send(records)
  })
  .catch(error => {
    console.log(error)
    res.status(500).send(`Error accessing DB: ${error}`)
  })
  .finally(() => { session.close() })

}


exports.get_received_applications_rejected = (req, res) => {
  // Returns applications rejected by a user

  var session = driver.session()
  session
  .run(`
    // Get applications submitted to logged user
    MATCH (applicant)<-[:SUBMITTED_BY]-(application:ApplicationForm)<-[:REJECTED]-(recipient:User)
    WHERE id(recipient)=toInteger($user_id)

    // Return
    RETURN application, applicant
    ORDER BY application.creation_date DESC
    `, {
      user_id: get_current_user_id(res),
  })
  .then((result) => {
    res.send(result.records)
  })
  .catch(error => { res.status(500).send(`Error accessing DB: ${error}`) })
  .finally(() => { session.close() })

}

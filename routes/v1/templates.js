const express = require('express')
const auth = require('../../auth.js')
const controller = require('../../controllers/v1/templates.js')

const router = express.Router()



router.use(auth.check_auth)

router.route('/')
  .post(controller.create_application_form_template)
  .get(controller.get_all_application_form_templates_visible_to_user)

router.route('/:template_id')
  .get(controller.get_application_form_template)
  .get(controller.get_application_form_template)
  .put(controller.edit_application_form_template)
  .delete(controller.delete_application_form_template)



module.exports = router

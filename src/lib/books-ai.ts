import { getZAI, chatWithRetry } from '@/lib/ai'
import { ACADEMY_INFO } from '@/lib/academyData'
import { ensureGeminiKey, geminiCompleteJson } from '@/lib/gemini'

// ===== خبير الذكاء الاصطناعي: اقتراح الكتب وتوليد الامتحانات الشاملة =====

export interface BookSuggestion {
  title: string
  titleEn: string
  author: string
  year: string
  reason: string
  link: string
}

export interface GeneratedQuestion {
  type: 'MCQ' | 'TF' | 'SHORT' | 'ESSAY'
  text: string
  options?: string[]
  correct?: string
  modelAnswer?: string
  points?: number
}

const LEVEL_AR: Record<string, string> = {
  DOCTORATE: 'الدكتوراه المهنية',
  MASTERS: 'الماجستير المهني',
  DIPLOMA: 'الدبلوم المهني المتقدم',
  ACCREDITATION: 'الاعتماد الدولي',
}

function cleanText(value: unknown, max = 1000): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function googleBooksSearch(title: string): string {
  return `https://books.google.com/books?q=${encodeURIComponent(title)}`
}

type ProgramDomain =
  | 'cybersecurity'
  | 'artificial-intelligence'
  | 'business-analytics'
  | 'business-administration'
  | 'strategic-management'
  | 'human-resources'
  | 'project-management'
  | 'marketing-management'
  | 'accounting-finance'
  | 'public-administration'
  | 'healthcare-management'
  | 'quality-management'
  | 'occupational-safety'
  | 'leadership-management'
  | 'training-development'
  | 'management-information-systems'
  | 'education-management'
  | 'kindergarten-management'
  | 'guidance-counseling'
  | 'learning-disabilities'
  | 'learning-resources'
  | 'journalism-media'
  | 'public-relations-customer-service'
  | 'tourism-management'
  | 'office-management'
  | 'insurance-management'
  | 'logistics-supply-chain'
  | 'procurement-contracts'
  | 'governance-risk-compliance'
  | 'crisis-disaster-management'
  | 'diplomacy-international-relations'
  | 'entrepreneurship'
  | 'general'

type BookSeed = [titleEn: string, author: string, year: string, reasonAr: string]

function norm(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
}

function specialtyName(program: { titleAr: string; titleEn?: string | null }): { ar: string; en: string } {
  const ar = cleanText(program.titleAr, 240)
    .replace(/^الماجستير\s+المهني\s+في\s+/u, '')
    .replace(/^الدكتوراه\s+المهنية\s+في\s+/u, '')
    .replace(/^الدبلوم\s+المهني\s+(المتقدم\s+)?في\s+/u, '')
    .trim()
  const en = cleanText(program.titleEn || '', 240)
    .replace(/^professional\s+master\s+in\s+/i, '')
    .replace(/^professional\s+doctorate\s+in\s+/i, '')
    .replace(/^professional\s+diploma\s+in\s+/i, '')
    .trim()
  return { ar: ar || cleanText(program.titleAr, 240), en: en || cleanText(program.titleEn || '', 240) }
}

function detectProgramDomain(input: { titleAr?: string | null; titleEn?: string | null; description?: string | null } | string): ProgramDomain {
  const text = typeof input === 'string'
    ? norm(input)
    : norm(`${input.titleAr || ''} ${input.titleEn || ''} ${input.description || ''}`)

  const checks: [ProgramDomain, RegExp][] = [
    ['cybersecurity', /امن سيبراني|cyber\s*security|cybersecurity|information security|network security|امن المعلومات|اختراق|تهديدات سيبرانيه/],
    ['artificial-intelligence', /ذكاء اصطناعي|تحول رقمي|artificial intelligence|\bai\b|digital transformation|machine learning|تعلم الي/],
    ['business-analytics', /تحليل البيانات|ذكاء الاعمال|business analytics|data analysis|data analytics|business intelligence/],
    ['management-information-systems', /نظم المعلومات الاداريه|management information systems|\bmis\b/],
    ['human-resources', /موارد بشريه|human resources|human resource|\bhr\b/],
    ['project-management', /اداره المشاريع|project management|pmp|agile|scrum/],
    ['marketing-management', /اداره التسويق|marketing management|digital marketing|تسويق/],
    ['accounting-finance', /محاسبه|ماليه|finance|accounting|financial/],
    ['public-administration', /اداره عامه|public administration|public management/],
    ['healthcare-management', /اداره صحيه|المستشفيات|healthcare|hospital management|health care/],
    ['quality-management', /جوده شامله|اداره الجوده|quality management|total quality|tqm|six sigma/],
    ['occupational-safety', /السلامه والصحه المهنيه|occupational health|occupational safety|\bosh\b|hse/],
    ['leadership-management', /قياده اداريه|leadership|managerial leadership/],
    ['training-development', /التدريب|تطوير الاداء|training|performance development/],
    ['education-management', /اداره تعليميه|educational management|educational leadership|school management/],
    ['kindergarten-management', /رياض الاطفال|طفوله مبكره|kindergarten|early childhood/],
    ['guidance-counseling', /توجيه وارشاد|ارشاد|counseling|guidance/],
    ['learning-disabilities', /صعوبات التعلم|learning disabilities/],
    ['learning-resources', /مصادر التعلم|learning resources|library|libraries/],
    ['journalism-media', /اعلام|صحافه|صحفيه|journalism|media/],
    ['public-relations-customer-service', /علاقات عامه|خدمه العملاء|public relations|customer service/],
    ['tourism-management', /سياحيه|فندقيه|tourism|hospitality/],
    ['office-management', /سكرتاريه|اداره المكاتب|office management|secretarial/],
    ['insurance-management', /تامين|اداره المخاطر|insurance|risk management/],
    ['logistics-supply-chain', /لوجستيات|سلاسل الامداد|supply chain|logistics/],
    ['procurement-contracts', /مشتريات|عقود|procurement|contracts/],
    ['governance-risk-compliance', /حوكمه|امتثال|governance|compliance|\bgrc\b/],
    ['crisis-disaster-management', /ازمات|كوارث|crisis|disaster/],
    ['diplomacy-international-relations', /دبلوماسيه|علاقات دوليه|diplomacy|international relations/],
    ['entrepreneurship', /رياده الاعمال|entrepreneurship|startup|startups/],
    ['strategic-management', /اداره استراتيجيه|strategic management|strategy/],
    ['business-administration', /اداره الاعمال|business administration|business management|mba/],
  ]
  return checks.find(([, re]) => re.test(text))?.[0] || 'general'
}

const DOMAIN_BOOKS: Partial<Record<ProgramDomain, BookSeed[]>> & { general: BookSeed[] } = {
  cybersecurity: [
    ['Security Engineering: A Guide to Building Dependable Distributed Systems', 'Ross J. Anderson', '2020', 'مرجع محوري في بناء الأنظمة الآمنة وتحليل المخاطر الأمنية عملياً.'],
    ['Computer Security: Principles and Practice', 'William Stallings & Lawrie Brown', 'حديث/متداول', 'يغطي مبادئ أمن الحاسوب والتهديدات والضوابط الأمنية بمستوى مناسب للماجستير.'],
    ['Cryptography and Network Security: Principles and Practice', 'William Stallings', 'حديث/متداول', 'يربط التشفير بأمن الشبكات والبروتوكولات والتطبيقات الأمنية.'],
    ['Network Security Essentials: Applications and Standards', 'William Stallings', 'حديث/متداول', 'مناسب لفهم أمن الشبكات والمعايير والتطبيقات الدفاعية.'],
    ['Web Application Security: Exploitation and Countermeasures for Modern Web Applications', 'Andrew Hoffman', '2020', 'يركز على أمن تطبيقات الويب والثغرات وطرق المعالجة الحديثة.'],
    ['Incident Response & Computer Forensics', 'Jason T. Luttgens, Matthew Pepe & Kevin Mandia', '2014', 'مهم لبناء قدرة الطالب على التعامل مع الحوادث والتحليل الجنائي الرقمي.'],
    ['Practical Malware Analysis', 'Michael Sikorski & Andrew Honig', '2012', 'مرجع عملي لفهم البرمجيات الخبيثة وتحليلها ضمن الأمن السيبراني.'],
    ['The Practice of Network Security Monitoring', 'Richard Bejtlich', '2013', 'يركز على المراقبة الأمنية واكتشاف التهديدات وتشغيل فرق الدفاع.'],
  ],
  'artificial-intelligence': [
    ['Artificial Intelligence: A Modern Approach', 'Stuart Russell & Peter Norvig', 'حديث/متداول', 'مرجع تأسيسي شامل في مفاهيم الذكاء الاصطناعي والخوارزميات.'],
    ['Deep Learning', 'Ian Goodfellow, Yoshua Bengio & Aaron Courville', '2016', 'يعطي أساساً علمياً قوياً للشبكات العميقة والتعلم التمثيلي.'],
    ['Hands-On Machine Learning with Scikit-Learn, Keras, and TensorFlow', 'Aurélien Géron', 'حديث/متداول', 'مرجع تطبيقي لبناء نماذج تعلم الآلة والتعلم العميق.'],
    ['Pattern Recognition and Machine Learning', 'Christopher M. Bishop', '2006', 'يدعم الفهم الرياضي والإحصائي للنماذج الذكية.'],
    ['Data Science for Business', 'Foster Provost & Tom Fawcett', '2013', 'يربط الذكاء الاصطناعي بقرارات الأعمال والتحول الرقمي.'],
    ['Human Compatible', 'Stuart Russell', '2019', 'مهم لفهم حوكمة الذكاء الاصطناعي ومخاطره الأخلاقية.'],
    ['Designing Machine Learning Systems', 'Chip Huyen', '2022', 'يركز على تشغيل نماذج الذكاء الاصطناعي في الإنتاج.'],
    ['Competing in the Age of AI', 'Marco Iansiti & Karim R. Lakhani', '2020', 'يناسب جانب التحول الرقمي والاستراتيجية المؤسسية بالذكاء الاصطناعي.'],
  ],
  'business-analytics': [
    ['Data Science for Business', 'Foster Provost & Tom Fawcett', '2013', 'مرجع أساسي لتحويل البيانات إلى قرارات أعمال.'],
    ['Business Analytics: Data Analysis and Decision Making', 'S. Christian Albright & Wayne Winston', 'حديث/متداول', 'يغطي التحليل الكمي والنمذجة واتخاذ القرار.'],
    ['Competing on Analytics', 'Thomas H. Davenport & Jeanne G. Harris', '2007', 'يوضح كيف تصنع المؤسسات ميزة تنافسية عبر التحليلات.'],
    ['Storytelling with Data', 'Cole Nussbaumer Knaflic', '2015', 'يعزز عرض نتائج التحليل بصرياً وإدارياً.'],
    ['Python for Data Analysis', 'Wes McKinney', 'حديث/متداول', 'مرجع تطبيقي لمعالجة البيانات وتحليلها.'],
    ['Practical Statistics for Data Scientists', 'Peter Bruce, Andrew Bruce & Peter Gedeck', 'حديث/متداول', 'يبني الأساس الإحصائي العملي لقرارات التحليل.'],
    ['The Data Warehouse Toolkit', 'Ralph Kimball & Margy Ross', 'حديث/متداول', 'مهم لفهم مستودعات البيانات ونمذجة ذكاء الأعمال.'],
    ['Business Intelligence Guidebook', 'Rick Sherman', '2014', 'يربط ذكاء الأعمال بالمنهجيات والأدوات المؤسسية.'],
  ],
  'business-administration': [
    ['Management', 'Stephen P. Robbins & Mary Coulter', 'حديث/متداول', 'مرجع شامل في وظائف الإدارة والمنظمات والقرار الإداري.'],
    ['Harvard Business Review Manager’s Handbook', 'Harvard Business Review Press', '2017', 'مرجع تطبيقي لأدوات الإدارة والقيادة اليومية.'],
    ['Essentials of Organizational Behavior', 'Stephen P. Robbins & Timothy A. Judge', 'حديث/متداول', 'يدعم فهم السلوك التنظيمي وإدارة الفرق.'],
    ['Competitive Strategy', 'Michael E. Porter', '1980', 'أساسي في تحليل المنافسة والميزة التنافسية.'],
    ['Operations Management', 'William J. Stevenson', 'حديث/متداول', 'مناسب لفهم العمليات والإنتاجية والجودة.'],
    ['Corporate Finance', 'Jonathan Berk & Peter DeMarzo', 'حديث/متداول', 'يغطي القرارات المالية الأساسية للمديرين.'],
    ['Marketing Management', 'Philip Kotler & Kevin Lane Keller', 'حديث/متداول', 'مرجع رئيسي في فهم السوق والعميل والاستراتيجية التسويقية.'],
    ['Business Model Generation', 'Alexander Osterwalder & Yves Pigneur', '2010', 'عملي في تصميم نماذج الأعمال والابتكار.'],
  ],
  'strategic-management': [
    ['Strategic Management: Concepts and Cases', 'Fred R. David & Forest R. David', 'حديث/متداول', 'مرجع تطبيقي لبناء وتحليل الاستراتيجيات.'],
    ['Contemporary Strategy Analysis', 'Robert M. Grant', 'حديث/متداول', 'يعطي إطاراً تحليلياً متقدماً للاستراتيجية والميزة التنافسية.'],
    ['Competitive Strategy', 'Michael E. Porter', '1980', 'كلاسيكي في تحليل الصناعة والقوى التنافسية.'],
    ['Blue Ocean Strategy', 'W. Chan Kim & Renée Mauborgne', '2005', 'يركز على الابتكار الاستراتيجي وخلق أسواق جديدة.'],
    ['Good Strategy Bad Strategy', 'Richard Rumelt', '2011', 'يفرق بين الاستراتيجية الحقيقية والشعارات الإدارية.'],
    ['Strategy Maps', 'Robert S. Kaplan & David P. Norton', '2004', 'يربط الاستراتيجية بمؤشرات الأداء والبطاقة المتوازنة.'],
    ['The Rise and Fall of Strategic Planning', 'Henry Mintzberg', '1994', 'مرجع نقدي مهم في التفكير الاستراتيجي.'],
    ['Playing to Win', 'A.G. Lafley & Roger L. Martin', '2013', 'يعرض منهجاً عملياً لاختيار الاستراتيجية وتنفيذها.'],
  ],
  'human-resources': [
    ['Human Resource Management', 'Gary Dessler', 'حديث/متداول', 'مرجع شامل في وظائف الموارد البشرية المعاصرة.'],
    ['Armstrong’s Handbook of Human Resource Management Practice', 'Michael Armstrong', 'حديث/متداول', 'مرجع مهني متقدم في سياسات وممارسات الموارد البشرية.'],
    ['Strategic Human Resource Management', 'Jeffrey A. Mello', 'حديث/متداول', 'يربط إدارة الموارد البشرية بالأهداف الاستراتيجية.'],
    ['Human Resource Champions', 'Dave Ulrich', '1997', 'كلاسيكي في دور الموارد البشرية كشريك استراتيجي.'],
    ['The HR Scorecard', 'Brian Becker, Mark Huselid & Dave Ulrich', '2001', 'يبني قياس أثر الموارد البشرية على الأداء.'],
    ['Investing in People', 'Wayne Cascio & John Boudreau', 'حديث/متداول', 'يعالج التحليلات والعائد من رأس المال البشري.'],
    ['The Talent Management Handbook', 'Lance A. Berger & Dorothy R. Berger', 'حديث/متداول', 'مناسب لتخطيط التعاقب واستقطاب المواهب.'],
    ['Organizational Behavior', 'Stephen P. Robbins & Timothy A. Judge', 'حديث/متداول', 'يدعم فهم السلوك التنظيمي والثقافة والتحفيز.'],
  ],
  'project-management': [
    ['A Guide to the Project Management Body of Knowledge (PMBOK Guide)', 'Project Management Institute', 'حديث/متداول', 'مرجع معياري في عمليات ومعارف إدارة المشاريع.'],
    ['Project Management: A Systems Approach to Planning, Scheduling, and Controlling', 'Harold Kerzner', 'حديث/متداول', 'مرجع متقدم في تخطيط ورقابة المشاريع.'],
    ['Agile Practice Guide', 'Project Management Institute & Agile Alliance', '2017', 'يربط إدارة المشاريع بالمنهجيات الرشيقة.'],
    ['Scrum: The Art of Doing Twice the Work in Half the Time', 'Jeff Sutherland', '2014', 'مدخل عملي لفهم Scrum وإدارة فرق المنتج.'],
    ['Project Management for Engineering, Business and Technology', 'John M. Nicholas & Herman Steyn', 'حديث/متداول', 'يناسب المشاريع المؤسسية والتقنية المتنوعة.'],
    ['Effective Project Management', 'Robert K. Wysocki', 'حديث/متداول', 'يركز على الأساليب التقليدية والرشيقة والتكيفية.'],
    ['Making Things Happen', 'Scott Berkun', '2008', 'يعطي منظوراً عملياً لإدارة التنفيذ والمخاطر.'],
    ['Project Risk Management Guidelines', 'Dale F. Cooper et al.', 'حديث/متداول', 'متخصص في إدارة مخاطر المشاريع.'],
  ],
  'marketing-management': [
    ['Marketing Management', 'Philip Kotler & Kevin Lane Keller', 'حديث/متداول', 'مرجع رئيسي في الاستراتيجية التسويقية وسلوك المستهلك.'],
    ['Principles of Marketing', 'Philip Kotler & Gary Armstrong', 'حديث/متداول', 'يبني الأساس المفاهيمي والتطبيقي للتسويق.'],
    ['Digital Marketing: Strategy, Implementation and Practice', 'Dave Chaffey & Fiona Ellis-Chadwick', 'حديث/متداول', 'متخصص في التسويق الرقمي والقنوات الإلكترونية.'],
    ['Consumer Behavior', 'Leon G. Schiffman & Joseph Wisenblit', 'حديث/متداول', 'مهم لفهم قرار الشراء وسلوك المستهلك.'],
    ['Positioning: The Battle for Your Mind', 'Al Ries & Jack Trout', '1981', 'كلاسيكي في تموضع العلامة والاتصال التسويقي.'],
    ['Building Strong Brands', 'David A. Aaker', '1996', 'أساسي في إدارة العلامات التجارية.'],
    ['Contagious: Why Things Catch On', 'Jonah Berger', '2013', 'يعالج الانتشار والتأثير الاجتماعي في التسويق.'],
    ['Marketing Analytics', 'Wayne L. Winston', 'حديث/متداول', 'يربط التسويق بالتحليلات وقياس الأداء.'],
  ],
  'accounting-finance': [
    ['Principles of Corporate Finance', 'Richard A. Brealey, Stewart C. Myers & Franklin Allen', 'حديث/متداول', 'مرجع أساسي في قرارات التمويل والاستثمار.'],
    ['Corporate Finance', 'Jonathan Berk & Peter DeMarzo', 'حديث/متداول', 'يعالج تقييم الشركات والهيكل المالي والمخاطر.'],
    ['Financial Accounting', 'Robert Libby, Patricia Libby & Frank Hodge', 'حديث/متداول', 'يبني أساس التقارير والقوائم المالية.'],
    ['Managerial Accounting', 'Ray H. Garrison, Eric Noreen & Peter Brewer', 'حديث/متداول', 'مهم للرقابة والتكاليف واتخاذ القرار الإداري.'],
    ['Financial Statement Analysis', 'K. R. Subramanyam', 'حديث/متداول', 'يركز على تحليل القوائم وتقييم الأداء.'],
    ['Investment Valuation', 'Aswath Damodaran', 'حديث/متداول', 'مرجع قوي في التقييم والاستثمار.'],
    ['Accounting Information Systems', 'Marshall B. Romney & Paul J. Steinbart', 'حديث/متداول', 'يربط المحاسبة بأنظمة المعلومات والرقابة.'],
    ['International Financial Reporting Standards (IFRS) Explained', 'Various IFRS authors', 'حديث/متداول', 'مفيد لفهم المعايير الدولية والتطبيقات العملية.'],
  ],
  'public-administration': [
    ['Public Administration: Concepts and Cases', 'Richard J. Stillman II', 'حديث/متداول', 'مرجع أساسي في مفاهيم وقضايا الإدارة العامة.'],
    ['Public Management and Governance', 'Tony Bovaird & Elke Löffler', 'حديث/متداول', 'يربط الإدارة العامة بالحوكمة وجودة الخدمات.'],
    ['The New Public Service', 'Janet V. Denhardt & Robert B. Denhardt', 'حديث/متداول', 'مهم لفهم خدمة المواطن والقيم العامة.'],
    ['Understanding and Managing Public Organizations', 'Hal G. Rainey', 'حديث/متداول', 'يركز على خصائص المنظمات العامة وإدارتها.'],
    ['Public Policy: Politics, Analysis, and Alternatives', 'Michael E. Kraft & Scott R. Furlong', 'حديث/متداول', 'يدعم تحليل السياسات العامة وصنع القرار.'],
    ['Bureaucracy', 'James Q. Wilson', '1989', 'كلاسيكي في فهم الأجهزة البيروقراطية.'],
    ['Managing the Public Sector', 'Grover Starling', 'حديث/متداول', 'مرجع تطبيقي لإدارة القطاع العام.'],
    ['The Oxford Handbook of Public Management', 'Ewan Ferlie, Laurence E. Lynn Jr. & Christopher Pollitt', '2005', 'مرجع متقدم وشامل في الإدارة العامة.'],
  ],
  'healthcare-management': [
    ['Health Care Management: Organization Design and Behavior', 'Stephen M. Shortell & Arnold D. Kaluzny', 'حديث/متداول', 'مرجع رئيسي في إدارة مؤسسات الرعاية الصحية.'],
    ['Healthcare Operations Management', 'Daniel B. McLaughlin & Julie M. Hays', 'حديث/متداول', 'يركز على العمليات والجودة والكفاءة في الرعاية الصحية.'],
    ['Introduction to Health Care Management', 'Sharon B. Buchbinder & Nancy H. Shanks', 'حديث/متداول', 'مدخل شامل لإدارة الرعاية الصحية والمستشفيات.'],
    ['The Well-Managed Healthcare Organization', 'John R. Griffith & Kenneth R. White', 'حديث/متداول', 'يعالج الأداء والحوكمة داخل المؤسسات الصحية.'],
    ['Health Policy and Politics', 'Jeri A. Milstead & Nancy M. Short', 'حديث/متداول', 'مهم لفهم السياسات الصحية والبيئة التنظيمية.'],
    ['Lean Hospitals', 'Mark Graban', 'حديث/متداول', 'يربط التحسين المستمر بتجربة المريض وتقليل الهدر.'],
    ['Quality and Performance Improvement in Healthcare', 'Patricia Shaw & Darcy Carter', 'حديث/متداول', 'متخصص في تحسين الجودة ومؤشرات الأداء الصحية.'],
    ['Strategic Management of Health Care Organizations', 'Peter M. Ginter, W. Jack Duncan & Linda E. Swayne', 'حديث/متداول', 'يركز على التخطيط والاستراتيجية في المؤسسات الصحية.'],
  ],
  'quality-management': [
    ['Juran’s Quality Handbook', 'Joseph M. Juran & Joseph A. De Feo', 'حديث/متداول', 'مرجع كلاسيكي شامل في إدارة الجودة.'],
    ['Quality Management for Organizational Excellence', 'David L. Goetsch & Stanley Davis', 'حديث/متداول', 'مناسب لفهم الجودة الشاملة والتحسين المستمر.'],
    ['Out of the Crisis', 'W. Edwards Deming', '1986', 'كلاسيكي في فلسفة الجودة والتحول الإداري.'],
    ['The Six Sigma Handbook', 'Thomas Pyzdek & Paul Keller', 'حديث/متداول', 'دليل تطبيقي لمنهجية ستة سيجما.'],
    ['Total Quality Management', 'Dale H. Besterfield et al.', 'حديث/متداول', 'يعرض أدوات ومفاهيم TQM بشكل منهجي.'],
    ['Lean Six Sigma and Minitab', 'Quentin Brook', 'حديث/متداول', 'يدعم التطبيق العملي والتحليل الإحصائي للجودة.'],
    ['The Machine That Changed the World', 'James P. Womack, Daniel T. Jones & Daniel Roos', '1990', 'أساسي لفهم التفكير الرشيق Lean.'],
    ['ISO 9001:2015 Explained', 'Charles A. Cianfrani & John E. West', 'حديث/متداول', 'يربط الجودة بالمعايير وأنظمة الإدارة.'],
  ],
  'occupational-safety': [
    ['Occupational Safety and Health for Technologists, Engineers, and Managers', 'David L. Goetsch', 'حديث/متداول', 'مرجع شامل في السلامة والصحة المهنية وإدارة المخاطر.'],
    ['Industrial Safety and Health Management', 'C. Ray Asfahl & David W. Rieske', 'حديث/متداول', 'يركز على أنظمة السلامة في بيئات العمل الصناعية.'],
    ['Safety Management Systems in a Joint Environment', 'Charles Billings', 'حديث/متداول', 'يعالج بناء أنظمة إدارة السلامة.'],
    ['Guidelines for Risk Based Process Safety', 'CCPS', 'حديث/متداول', 'مهم لفهم مخاطر العمليات والتحكم الوقائي.'],
    ['The Safety Professionals Handbook', 'Joel M. Haight', 'حديث/متداول', 'مرجع مهني واسع للممارسين في السلامة.'],
    ['Introduction to Health and Safety at Work', 'Phil Hughes & Ed Ferrett', 'حديث/متداول', 'مدخل عملي للتشريعات والممارسات الأساسية.'],
    ['Accident Prevention Manual', 'National Safety Council', 'حديث/متداول', 'يركز على الوقاية والتحقيق في الحوادث.'],
    ['Risk Assessment: A Practical Guide to Assessing Operational Risks', 'Georgi Popov et al.', 'حديث/متداول', 'يدعم تقييم المخاطر في بيئات العمل.'],
  ],
  'leadership-management': [
    ['Leadership in Organizations', 'Gary Yukl', 'حديث/متداول', 'مرجع أكاديمي قوي في نظريات وممارسات القيادة.'],
    ['The Leadership Challenge', 'James M. Kouzes & Barry Z. Posner', 'حديث/متداول', 'عملي في بناء السلوك القيادي والتأثير.'],
    ['Primal Leadership', 'Daniel Goleman, Richard Boyatzis & Annie McKee', '2002', 'يربط القيادة بالذكاء العاطفي والثقافة التنظيمية.'],
    ['Leaders Eat Last', 'Simon Sinek', '2014', 'يعالج بناء الثقة والفرق عالية الأداء.'],
    ['The Practice of Adaptive Leadership', 'Ronald Heifetz, Marty Linsky & Alexander Grashow', '2009', 'مهم للتعامل مع التغيير والتحديات المعقدة.'],
    ['On Leadership', 'John W. Gardner', '1990', 'كلاسيكي في فهم القيم والمسؤولية القيادية.'],
    ['Leadership: Theory and Practice', 'Peter G. Northouse', 'حديث/متداول', 'يعطي إطاراً أكاديمياً منظماً لنظريات القيادة.'],
    ['The Five Dysfunctions of a Team', 'Patrick Lencioni', '2002', 'مفيد لفهم قيادة الفرق وبناء الثقة.'],
  ],
  'training-development': [
    ['Designing Effective Instruction', 'Gary R. Morrison, Steven M. Ross & Jerrold E. Kemp', 'حديث/متداول', 'مرجع في تصميم التعليم والتدريب وتحليل الاحتياجات.'],
    ['Telling Ain’t Training', 'Harold D. Stolovitch & Erica J. Keeps', 'حديث/متداول', 'يوضح الفرق بين الإلقاء وبناء تجربة تعلم فعالة.'],
    ['The Adult Learner', 'Malcolm S. Knowles, Elwood F. Holton & Richard A. Swanson', 'حديث/متداول', 'أساسي في تعلم الكبار والتدريب المهني.'],
    ['ASTD Handbook', 'Elaine Biech', 'حديث/متداول', 'مرجع شامل في التدريب وتطوير الموارد البشرية.'],
    ['Evaluating Training Programs', 'Donald L. Kirkpatrick & James D. Kirkpatrick', 'حديث/متداول', 'يعرض نموذج كيركباتريك لقياس أثر التدريب.'],
    ['Performance Consulting', 'Dana Gaines Robinson & James C. Robinson', 'حديث/متداول', 'يربط التدريب بتحسين الأداء المؤسسي.'],
    ['Instructional Design', 'Patricia L. Smith & Tillman J. Ragan', 'حديث/متداول', 'يدعم تصميم البرامج التدريبية منهجياً.'],
    ['Make It Stick', 'Peter C. Brown, Henry L. Roediger III & Mark A. McDaniel', '2014', 'يعالج علم التعلم والتذكر ونقل الأثر التدريبي.'],
  ],
  'management-information-systems': [
    ['Management Information Systems: Managing the Digital Firm', 'Kenneth C. Laudon & Jane P. Laudon', 'حديث/متداول', 'مرجع أساسي في نظم المعلومات والمنظمات الرقمية.'],
    ['Business Driven Information Systems', 'Paige Baltzan', 'حديث/متداول', 'يربط نظم المعلومات بأهداف الأعمال.'],
    ['Information Systems Today', 'Joseph Valacich & Christoph Schneider', 'حديث/متداول', 'يغطي التطبيقات الحديثة والتحول الرقمي.'],
    ['Enterprise Architecture As Strategy', 'Jeanne W. Ross, Peter Weill & David Robertson', '2006', 'مهم لفهم بنية المؤسسة الرقمية.'],
    ['IT Governance', 'Peter Weill & Jeanne W. Ross', '2004', 'يركز على حوكمة تقنية المعلومات والقرار المؤسسي.'],
    ['Database System Concepts', 'Abraham Silberschatz, Henry Korth & S. Sudarshan', 'حديث/متداول', 'يبني أساس قواعد البيانات لنظم المعلومات.'],
    ['Business Process Management', 'Mathias Weske', 'حديث/متداول', 'يربط العمليات بنظم المعلومات والتحسين.'],
    ['Digital Transformation', 'Thomas M. Siebel', '2019', 'يعرض تقنيات التحول الرقمي في المؤسسات.'],
  ],
  'education-management': [
    ['Educational Administration: Theory, Research, and Practice', 'Wayne K. Hoy & Cecil G. Miskel', 'حديث/متداول', 'مرجع أساسي في الإدارة التعليمية ونظرياتها.'],
    ['School Leadership That Works', 'Robert J. Marzano, Timothy Waters & Brian A. McNulty', '2005', 'يربط القيادة المدرسية بتحسين نتائج التعلم.'],
    ['Leading in a Culture of Change', 'Michael Fullan', 'حديث/متداول', 'مهم لفهم قيادة التغيير في المؤسسات التعليمية.'],
    ['The Principal: Three Keys to Maximizing Impact', 'Michael Fullan', '2014', 'يركز على دور المدير في تحسين المدرسة.'],
    ['Instructional Leadership', 'Anita Woolfolk Hoy & Wayne K. Hoy', 'حديث/متداول', 'يعالج القيادة التعليمية وتحسين التدريس.'],
    ['Visible Learning', 'John Hattie', 'حديث/متداول', 'مفيد لربط الإدارة التعليمية بالأثر التعليمي.'],
    ['Professional Capital', 'Andy Hargreaves & Michael Fullan', '2012', 'يناقش تطوير المعلمين وبناء رأس المال المهني.'],
    ['The Fifth Discipline Fieldbook for Educators', 'Peter Senge et al.', 'حديث/متداول', 'يطبق التعلم المؤسسي داخل المؤسسات التعليمية تحديداً.'],
  ],
  'kindergarten-management': [
    ['Developmentally Appropriate Practice in Early Childhood Programs', 'NAEYC', 'حديث/متداول', 'مرجع عملي في إدارة برامج الطفولة المبكرة.'],
    ['Early Childhood Education Today', 'George S. Morrison', 'حديث/متداول', 'يغطي المفاهيم والممارسات الأساسية لرياض الأطفال.'],
    ['Theories of Childhood', 'Carol Garhart Mooney', 'حديث/متداول', 'يعرض نظريات نمو الطفل وتطبيقاتها.'],
    ['Administration of Programs for Young Children', 'Phyllis M. Click & Kimberly A. Karkos', 'حديث/متداول', 'متخصص في إدارة مؤسسات وبرامج الطفولة.'],
    ['The Intentional Teacher', 'Ann S. Epstein', 'حديث/متداول', 'يدعم التخطيط التعليمي في الطفولة المبكرة.'],
    ['Working with Families of Young Children', 'Rena Shimoni & Joanne Baxter', 'حديث/متداول', 'يركز على الشراكة مع الأسر في رياض الأطفال.'],
    ['Early Childhood Environment Rating Scale', 'Thelma Harms, Richard M. Clifford & Debby Cryer', 'حديث/متداول', 'مفيد لتقييم جودة بيئات الطفولة.'],
    ['Leadership in Early Childhood', 'Jillian Rodd', 'حديث/متداول', 'يعالج القيادة والإدارة في مؤسسات الطفولة المبكرة.'],
  ],
  'guidance-counseling': [
    ['The Skilled Helper', 'Gerard Egan', 'حديث/متداول', 'مرجع رئيسي في مهارات الإرشاد والمساعدة.'],
    ['Theory and Practice of Counseling and Psychotherapy', 'Gerald Corey', 'حديث/متداول', 'يعرض النظريات الإرشادية وتطبيقاتها.'],
    ['Counseling Children', 'Donna A. Henderson & Charles L. Thompson', 'حديث/متداول', 'مهم للإرشاد المدرسي وإرشاد الأطفال.'],
    ['School Counseling Principles: Ethics and Law', 'Carolyn Stone', 'حديث/متداول', 'يركز على أخلاقيات وقوانين الإرشاد المدرسي.'],
    ['Solution-Focused Counseling in Schools', 'John J. Murphy', 'حديث/متداول', 'عملي في الإرشاد المدرسي المختصر.'],
    ['Motivational Interviewing', 'William R. Miller & Stephen Rollnick', 'حديث/متداول', 'يدعم المقابلة التحفيزية وبناء الدافعية.'],
    ['Group Counseling: Strategies and Skills', 'Ed Jacobs, Robert Masson & Riley Harvill', 'حديث/متداول', 'يناسب الإرشاد الجمعي وتطوير المهارات.'],
    ['Career Development and Counseling', 'Steven D. Brown & Robert W. Lent', 'حديث/متداول', 'متخصص في الإرشاد المهني والتوجيه الوظيفي.'],
  ],
  'learning-disabilities': [
    ['Learning Disabilities: Characteristics, Identification, and Teaching Strategies', 'Bob Algozzine & James Ysseldyke', 'حديث/متداول', 'مرجع تطبيقي في تشخيص وتعليم ذوي صعوبات التعلم.'],
    ['Learning Disabilities and Related Disabilities', 'Janet W. Lerner & Beverley Johns', 'حديث/متداول', 'يغطي الخصائص والتدخلات التربوية.'],
    ['Essentials of Specific Learning Disability Identification', 'Vincent C. Alfonso & Dawn P. Flanagan', 'حديث/متداول', 'مهم لفهم التقييم والتشخيص.'],
    ['Teaching Students with Learning Problems', 'Cecil D. Mercer & Ann R. Mercer', 'حديث/متداول', 'يركز على استراتيجيات التدريس العلاجي.'],
    ['Overcoming Dyslexia', 'Sally Shaywitz', 'حديث/متداول', 'مرجع مهم في عسر القراءة والتدخلات.'],
    ['Explicit Instruction', 'Anita L. Archer & Charles A. Hughes', '2011', 'يعالج التدريس المباشر الفعال للمتعلمين المتعثرين.'],
    ['Assessment in Special and Inclusive Education', 'John Salvia, James Ysseldyke & Sara Bolt', 'حديث/متداول', 'يربط التقييم بخطط التدخل.'],
    ['High-Leverage Practices in Special Education', 'Council for Exceptional Children', 'حديث/متداول', 'يعرض ممارسات فعالة في التربية الخاصة.'],
  ],
  'learning-resources': [
    ['Information Services Today', 'Sandra Hirsh', 'حديث/متداول', 'مرجع حديث في خدمات المعلومات ومصادر التعلم.'],
    ['Library and Information Center Management', 'Barbara B. Moran, Robert D. Stueart & Claudia J. Morner', 'حديث/متداول', 'أساسي في إدارة المكتبات ومراكز المعلومات.'],
    ['The School Library Manager', 'Blanche Woolls', 'حديث/متداول', 'متخصص في إدارة مكتبات ومصادر التعلم المدرسية.'],
    ['Introduction to Information Science', 'David Bawden & Lyn Robinson', 'حديث/متداول', 'يبني أساس علم المعلومات وتنظيم المعرفة.'],
    ['Reference and Information Services', 'Kay Ann Cassell & Uma Hiremath', 'حديث/متداول', 'مفيد لخدمات المراجع ودعم المستفيدين.'],
    ['Digital Libraries', 'William Y. Arms', '2000', 'يعالج المكتبات الرقمية وإتاحة المعرفة.'],
    ['The Information Society', 'John Feather', 'حديث/متداول', 'يفهم دور المعلومات في المجتمع والمؤسسات.'],
    ['Managing and Improving Electronic Thesis and Dissertation Programs', 'Suzie Allard et al.', 'حديث/متداول', 'يربط الإدارة المعرفية بالمصادر الرقمية الأكاديمية.'],
  ],
  'journalism-media': [
    ['Journalism: Principles and Practice', 'Tony Harcup', 'حديث/متداول', 'مرجع شامل في مبادئ وممارسات الصحافة.'],
    ['The Elements of Journalism', 'Bill Kovach & Tom Rosenstiel', 'حديث/متداول', 'كلاسيكي في قيم الصحافة والتحقق والمساءلة.'],
    ['Multimedia Journalism', 'Andy Bull', 'حديث/متداول', 'يناسب الإعلام الرقمي وإنتاج المحتوى متعدد الوسائط.'],
    ['Media Ethics: Issues and Cases', 'Philip Patterson & Lee Wilkins', 'حديث/متداول', 'يعالج أخلاقيات الإعلام والحالات العملية.'],
    ['News Writing and Reporting', 'Chip Scanlan & Richard Craig', 'حديث/متداول', 'يركز على الكتابة الصحفية والتحرير.'],
    ['Convergence Culture', 'Henry Jenkins', '2006', 'مهم لفهم تحولات الإعلام والجمهور الرقمي.'],
    ['The Online Journalism Handbook', 'Paul Bradshaw & Liisa Rohumaa', 'حديث/متداول', 'عملي في الصحافة الرقمية والتحقق.'],
    ['Broadcast Journalism', 'Andrew Boyd, Peter Stewart & Ray Alexander', 'حديث/متداول', 'مناسب للإذاعة والتلفزيون وإعداد التقارير.'],
  ],
  'public-relations-customer-service': [
    ['Effective Public Relations', 'Scott M. Cutlip, Allen H. Center & Glen M. Broom', 'حديث/متداول', 'مرجع رئيسي في العلاقات العامة وإدارة السمعة.'],
    ['The New Rules of Marketing and PR', 'David Meerman Scott', 'حديث/متداول', 'يربط العلاقات العامة بالاتصال الرقمي والمحتوى.'],
    ['Customer Service: Career Success Through Customer Loyalty', 'Paul R. Timm', 'حديث/متداول', 'مفيد في مهارات خدمة العملاء وبناء الولاء.'],
    ['Services Marketing', 'Valarie A. Zeithaml, Mary Jo Bitner & Dwayne D. Gremler', 'حديث/متداول', 'يربط الخدمة بتجربة العميل وجودة الخدمة.'],
    ['Excellence in Public Relations and Communication Management', 'James E. Grunig', '1992', 'كلاسيكي في نماذج العلاقات العامة الاستراتيجية.'],
    ['Reputation Management', 'John Doorley & Helio Fred Garcia', 'حديث/متداول', 'يركز على السمعة والأزمات والاتصال المؤسسي.'],
    ['Delivering Happiness', 'Tony Hsieh', '2010', 'يعطي مثالاً عملياً في ثقافة خدمة العملاء.'],
    ['The Customer Rules', 'Lee Cockerell', '2013', 'يعرض قواعد عملية لتجربة العميل.'],
  ],
  'tourism-management': [
    ['Tourism Management', 'Stephen J. Page', 'حديث/متداول', 'مرجع شامل في إدارة السياحة والوجهات.'],
    ['Hospitality Management and Organisational Behaviour', 'Laurie J. Mullins', 'حديث/متداول', 'يربط الإدارة بالسلوك التنظيمي في الضيافة.'],
    ['Introduction to Hospitality Management', 'John R. Walker', 'حديث/متداول', 'مدخل عملي لإدارة الفنادق والضيافة.'],
    ['Tourism: Principles and Practice', 'John Fletcher et al.', 'حديث/متداول', 'يغطي مبادئ السياحة والأسواق والسياسات.'],
    ['Strategic Management for Tourism, Hospitality and Events', 'Nigel Evans', 'حديث/متداول', 'يركز على الاستراتيجية في السياحة والفعاليات.'],
    ['Marketing for Hospitality and Tourism', 'Philip Kotler, John Bowen & James Makens', 'حديث/متداول', 'مهم للتسويق السياحي والفندقي.'],
    ['The Business of Tourism', 'J. Christopher Holloway & Claire Humphreys', 'حديث/متداول', 'يعرض صناعة السياحة ومكوناتها.'],
    ['Sustainable Tourism', 'David Weaver', 'حديث/متداول', 'مفيد لفهم الاستدامة في السياحة.'],
  ],
  'office-management': [
    ['Administrative Office Management', 'Pattie Odgers', 'حديث/متداول', 'مرجع في تنظيم العمل المكتبي والإداري.'],
    ['Records Management', 'Judith Read & Mary Lea Ginn', 'حديث/متداول', 'أساسي في إدارة السجلات والمعلومات.'],
    ['Office Management', 'R. K. Chopra', 'حديث/متداول', 'يغطي وظائف المكتب والسكرتارية الحديثة.'],
    ['The Administrative Professional', 'Patsy Fulton-Calkins', 'حديث/متداول', 'يعالج مهارات السكرتارية والاحتراف الإداري.'],
    ['Business Communication', 'Mary Ellen Guffey & Dana Loewy', 'حديث/متداول', 'مهم للمراسلات والاتصال الإداري.'],
    ['Time Management', 'Brian Tracy', 'حديث/متداول', 'يدعم تنظيم الأولويات والإنتاجية المكتبية.'],
    ['Document and Record Management Systems', 'Michael J. D. Sutton', 'حديث/متداول', 'يربط إدارة الوثائق بالتحول الرقمي.'],
    ['Office 365 for Administrators', 'Various technical authors', 'حديث/متداول', 'يدعم جانب الأدوات الرقمية في إدارة المكاتب.'],
  ],
  'insurance-management': [
    ['Principles of Risk Management and Insurance', 'George E. Rejda & Michael McNamara', 'حديث/متداول', 'مرجع أساسي في التأمين وإدارة المخاطر.'],
    ['Risk Management and Insurance', 'Scott Harrington & Gregory Niehaus', 'حديث/متداول', 'يعالج نماذج المخاطر والأسواق التأمينية.'],
    ['Fundamentals of Risk and Insurance', 'Emmett J. Vaughan & Therese Vaughan', 'حديث/متداول', 'مدخل شامل لمبادئ التأمين وإدارة المخاطر.'],
    ['Enterprise Risk Management', 'James Lam', 'حديث/متداول', 'يربط المخاطر بالحوكمة والاستراتيجية.'],
    ['Insurance Theory and Practice', 'Rob Thoyts', 'حديث/متداول', 'مناسب لفهم الصناعة والتطبيقات العملية.'],
    ['Against the Gods: The Remarkable Story of Risk', 'Peter L. Bernstein', '1996', 'يعطي خلفية فكرية وتاريخية لإدارة المخاطر.'],
    ['Risk Management and Financial Institutions', 'John C. Hull', 'حديث/متداول', 'مهم لمخاطر المؤسسات المالية.'],
    ['Operational Risk Management', 'Ariane Chapelle', 'حديث/متداول', 'يركز على المخاطر التشغيلية والضوابط.'],
  ],
  'logistics-supply-chain': [
    ['Supply Chain Management: Strategy, Planning, and Operation', 'Sunil Chopra', 'حديث/متداول', 'مرجع رئيسي في استراتيجية وتخطيط سلاسل الإمداد.'],
    ['Logistics & Supply Chain Management', 'Martin Christopher', 'حديث/متداول', 'يعالج اللوجستيات والقيمة والتكامل.'],
    ['Designing and Managing the Supply Chain', 'David Simchi-Levi, Philip Kaminsky & Edith Simchi-Levi', 'حديث/متداول', 'يركز على تصميم الشبكات والتحليلات.'],
    ['The Goal', 'Eliyahu M. Goldratt', 'حديث/متداول', 'كلاسيكي في الاختناقات وتحسين التدفق.'],
    ['Global Logistics and Supply Chain Management', 'John Mangan & Chandra Lalwani', 'حديث/متداول', 'يناسب البيئة الدولية للوجستيات.'],
    ['Operations and Supply Chain Management', 'F. Robert Jacobs & Richard Chase', 'حديث/متداول', 'يربط العمليات بسلاسل الإمداد.'],
    ['Supply Chain Risk Management', 'Donald Waters', 'حديث/متداول', 'يركز على مخاطر سلاسل الإمداد والمرونة.'],
    ['Lean Supply Chain and Logistics Management', 'Paul Myerson', 'حديث/متداول', 'يعالج اللوجستيات الرشيقة وتقليل الهدر.'],
  ],
  'procurement-contracts': [
    ['Purchasing and Supply Chain Management', 'Robert M. Monczka et al.', 'حديث/متداول', 'مرجع أساسي في المشتريات وسلاسل التوريد.'],
    ['Contract Management Body of Knowledge (CMBOK)', 'National Contract Management Association', 'حديث/متداول', 'مرجع مهني في إدارة العقود والمشتريات.'],
    ['World Class Contracting', 'Gregory A. Garrett', 'حديث/متداول', 'يركز على ممارسات التعاقد الفعالة.'],
    ['Strategic Supply Management', 'Paul Cousins et al.', 'حديث/متداول', 'يعالج المشتريات كوظيفة استراتيجية.'],
    ['Procurement Principles and Management', 'Peter Baily et al.', 'حديث/متداول', 'مدخل شامل لإدارة الشراء والتوريد.'],
    ['Commercial Contract Management', 'Various contract management authors', 'حديث/متداول', 'يدعم صياغة ومتابعة العقود التجارية.'],
    ['The Contract Negotiation Handbook', 'Stephen Guth', 'حديث/متداول', 'عملي في التفاوض وإدارة شروط العقود.'],
    ['Category Management in Purchasing', 'Jonathan O’Brien', 'حديث/متداول', 'يركز على إدارة الفئات الشرائية وتحقيق القيمة.'],
  ],
  'governance-risk-compliance': [
    ['Corporate Governance', 'Robert A. G. Monks & Nell Minow', 'حديث/متداول', 'مرجع أساسي في الحوكمة المؤسسية.'],
    ['Enterprise Risk Management', 'James Lam', 'حديث/متداول', 'يربط المخاطر بالاستراتيجية والحوكمة.'],
    ['COSO Enterprise Risk Management Framework', 'COSO', 'حديث/متداول', 'إطار مرجعي في إدارة المخاطر المؤسسية.'],
    ['Governance, Risk Management, and Compliance', 'Richard M. Steinberg', 'حديث/متداول', 'يربط GRC بالرقابة والامتثال.'],
    ['The Handbook of Board Governance', 'Richard Leblanc', 'حديث/متداول', 'مفيد في فهم مجالس الإدارة والرقابة.'],
    ['IT Governance', 'Peter Weill & Jeanne W. Ross', '2004', 'يركز على حوكمة تقنية المعلومات ضمن المؤسسة.'],
    ['Compliance 101', 'Debbie Troklus et al.', 'حديث/متداول', 'مدخل مهني لبرامج الامتثال.'],
    ['Risk Management and Financial Institutions', 'John C. Hull', 'حديث/متداول', 'يعالج نماذج المخاطر والرقابة في المؤسسات المالية.'],
  ],
  'crisis-disaster-management': [
    ['Crisis Management: Planning for the Inevitable', 'Steven Fink', 'حديث/متداول', 'مرجع كلاسيكي في التخطيط للأزمات.'],
    ['Disaster Recovery', 'Brenda D. Phillips, Deborah S. K. Thomas et al.', 'حديث/متداول', 'يركز على التعافي وإدارة الكوارث.'],
    ['Introduction to Emergency Management', 'George Haddow, Jane Bullock & Damon Coppola', 'حديث/متداول', 'مدخل شامل لإدارة الطوارئ.'],
    ['The Human Side of Disaster', 'Thomas E. Drabek', 'حديث/متداول', 'يعالج السلوك الإنساني والاجتماعي أثناء الكوارث.'],
    ['Managing Crises', 'Arnold M. Howitt & Herman B. Leonard', 'حديث/متداول', 'يربط القيادة والسياسات العامة بالأزمات.'],
    ['Disaster Risk Reduction', 'Mark Pelling', 'حديث/متداول', 'مهم في تقليل المخاطر والجاهزية.'],
    ['Crisis Communications', 'Kathleen Fearn-Banks', 'حديث/متداول', 'يركز على الاتصال أثناء الأزمات.'],
    ['Handbook of Disaster Research', 'Havidán Rodríguez, William Donner & Joseph Trainor', 'حديث/متداول', 'مرجع بحثي متقدم في دراسات الكوارث.'],
  ],
  'diplomacy-international-relations': [
    ['Diplomacy', 'Henry Kissinger', '1994', 'مرجع كلاسيكي في الدبلوماسية والعلاقات الدولية.'],
    ['Global Diplomacy', 'Thierry Balzacq, Frédéric Charillon & Frédéric Ramel', 'حديث/متداول', 'يعرض الدبلوماسية الحديثة وتعدد الفاعلين.'],
    ['The Globalization of World Politics', 'John Baylis, Steve Smith & Patricia Owens', 'حديث/متداول', 'مدخل شامل لنظريات وقضايا العلاقات الدولية.'],
    ['International Relations Theories', 'Tim Dunne, Milja Kurki & Steve Smith', 'حديث/متداول', 'يبني الأساس النظري للتحليل الدولي.'],
    ['Diplomacy: Theory and Practice', 'G. R. Berridge', 'حديث/متداول', 'مباشر في أدوات وممارسات الدبلوماسية.'],
    ['The Oxford Handbook of Modern Diplomacy', 'Andrew F. Cooper, Jorge Heine & Ramesh Thakur', '2013', 'مرجع متقدم في الدبلوماسية المعاصرة.'],
    ['Man, the State, and War', 'Kenneth N. Waltz', '1959', 'كلاسيكي في أسباب الصراع الدولي.'],
    ['Theories of International Politics and Zombies', 'Daniel W. Drezner', 'حديث/متداول', 'مدخل مبسط ومفيد لنظريات العلاقات الدولية.'],
  ],
  entrepreneurship: [
    ['The Lean Startup', 'Eric Ries', '2011', 'مرجع محوري في بناء المشاريع الناشئة والتحقق من السوق.'],
    ['Entrepreneurship', 'William D. Bygrave & Andrew Zacharakis', 'حديث/متداول', 'مرجع أكاديمي شامل في ريادة الأعمال.'],
    ['Business Model Generation', 'Alexander Osterwalder & Yves Pigneur', '2010', 'عملي في تصميم نماذج الأعمال.'],
    ['Disciplined Entrepreneurship', 'Bill Aulet', 'حديث/متداول', 'منهج خطوة بخطوة لتأسيس المشاريع.'],
    ['The Startup Owner’s Manual', 'Steve Blank & Bob Dorf', '2012', 'يركز على تطوير العملاء وبناء الشركة الناشئة.'],
    ['Effectual Entrepreneurship', 'Stuart Read et al.', 'حديث/متداول', 'يعرض منطق الريادة بالموارد المتاحة.'],
    ['Zero to One', 'Peter Thiel & Blake Masters', '2014', 'مفيد في التفكير الابتكاري والميزة الفريدة.'],
    ['Innovation and Entrepreneurship', 'Peter F. Drucker', '1985', 'كلاسيكي في ربط الابتكار بالفرص الريادية.'],
  ],
  general: [
    ['Research Design: Qualitative, Quantitative, and Mixed Methods Approaches', 'John W. Creswell & J. David Creswell', 'حديث/متداول', 'مرجع منهجي أساسي للبحوث الأكاديمية والمهنية.'],
    ['Research Methodology: Methods and Techniques', 'C. R. Kothari', '2004', 'مرجع واضح في تصميم البحث وجمع البيانات وتحليلها.'],
    ['How to Write a Master’s Thesis', 'Yvonne N. Bui', 'حديث/متداول', 'يساعد الطالب في بناء البحث والمشروع النهائي.'],
    ['Doing Your Research Project', 'Judith Bell & Stephen Waters', 'حديث/متداول', 'دليل تطبيقي لتخطيط وتنفيذ البحث.'],
    ['Case Study Research and Applications', 'Robert K. Yin', 'حديث/متداول', 'مهم للبحوث التطبيقية ودراسات الحالة.'],
    ['The Craft of Research', 'Wayne C. Booth, Gregory G. Colomb & Joseph M. Williams', 'حديث/متداول', 'يبني مهارات صياغة الحجج والكتابة البحثية.'],
    ['Qualitative Inquiry and Research Design', 'John W. Creswell & Cheryl N. Poth', 'حديث/متداول', 'يعالج البحث النوعي بتفصيل مناسب للدراسات العليا.'],
    ['Practical Research: Planning and Design', 'Paul D. Leedy & Jeanne Ellis Ormrod', 'حديث/متداول', 'ينظم خطوات التخطيط والمنهجية وتحليل البيانات.'],
  ],
}

const COMPATIBLE_DOMAINS: Partial<Record<ProgramDomain, ProgramDomain[]>> = {
  'business-administration': ['strategic-management', 'human-resources', 'marketing-management', 'project-management', 'accounting-finance', 'leadership-management', 'quality-management'],
  'public-administration': ['leadership-management', 'strategic-management', 'governance-risk-compliance'],
  'management-information-systems': ['business-analytics', 'artificial-intelligence', 'cybersecurity'],
  'governance-risk-compliance': ['insurance-management', 'cybersecurity'],
}

function isCompatibleDomain(programDomain: ProgramDomain, bookDomain: ProgramDomain): boolean {
  if (programDomain === 'general' || bookDomain === 'general') return true
  return programDomain === bookDomain || (COMPATIBLE_DOMAINS[programDomain] || []).includes(bookDomain)
}

function isSuggestionRelevantToDomain(s: BookSuggestion, programDomain: ProgramDomain): boolean {
  if (programDomain === 'general') return true
  const titleBlob = `${s.title} ${s.titleEn}`
  const bookDomain = detectProgramDomain(titleBlob)
  if (bookDomain !== 'general') return isCompatibleDomain(programDomain, bookDomain)

  const domainSeeds = DOMAIN_BOOKS[programDomain] || []
  const title = norm(titleBlob)
  return domainSeeds.some(([seedTitle]) => {
    const main = norm(seedTitle).split(':')[0].slice(0, 26)
    return main.length >= 8 && title.includes(main)
  })
}

async function completeJsonWithFallback(args: {
  system: string
  prompt: string
  label: string
  temperature?: number
  maxOutputTokens?: number
  retries?: number
}): Promise<string> {
  const errors: string[] = []

  if (await ensureGeminiKey().catch(() => false)) {
    try {
      return await geminiCompleteJson({
        system: args.system,
        history: [{ role: 'user', text: args.prompt }],
        temperature: args.temperature ?? 0.25,
        maxOutputTokens: args.maxOutputTokens ?? 4096,
      })
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 220)
      errors.push(`Gemini: ${msg}`)
      console.error(`${args.label} Gemini failed:`, msg)
    }
  } else {
    errors.push('Gemini: GEMINI_NOT_CONFIGURED')
  }

  try {
    const zai = await getZAI()
    return await chatWithRetry(
      zai,
      [
        { role: 'assistant', content: args.system },
        { role: 'user', content: args.prompt },
      ],
      args.retries ?? 3
    )
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 220)
    errors.push(`ZAI: ${msg}`)
    console.error(`${args.label} ZAI failed:`, msg)
  }

  throw new Error(`${args.label} AI failed — ${errors.join(' | ')}`)
}

function extractJsonArray(raw: string): any[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return parseLoose(raw)
  try {
    const arr = JSON.parse(raw.slice(start, end + 1))
    return Array.isArray(arr) ? arr : parseLoose(raw)
  } catch {
    return parseLoose(raw)
  }
}

/** إصلاح علامات التنصيص الداخلية غير المهرّبة داخل سطر JSON */
function repairJsonQuotes(s: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (!inStr) {
      if (ch === '"') inStr = true
      out += ch
      continue
    }
    if (ch === '\\') {
      out += ch + (s[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < s.length && /\s/.test(s[j])) j++
      const nxt = s[j]
      if (nxt === ',' || nxt === '}' || nxt === ']' || nxt === ':' || j >= s.length) {
        inStr = false
        out += ch
      } else {
        out += '\\"'
      }
      continue
    }
    out += ch
  }
  return out
}

function tryParseJsonObject(t: string): any | null {
  let s = t.trim().replace(/^\d+[.)\-]\s*/, '').replace(/[،,]\s*$/, '')
  if (!s.startsWith('{')) return null
  try {
    return JSON.parse(s)
  } catch {}
  try {
    return JSON.parse(repairJsonQuotes(s))
  } catch {}
  return null
}

/** استخراج متسامح: مصفوفة كاملة ← سطر بسطر ← مطابقة أقواس كائن-كائن */
function parseLoose(raw: string): any[] {
  const byLine: any[] = []
  for (const line of raw.split('\n')) {
    const obj = tryParseJsonObject(line)
    if (obj) byLine.push(obj)
  }
  if (byLine.length >= 3) return byLine

  const objs: any[] = []
  let depth = 0
  let cur = ''
  let inStr = false
  let esc = false
  for (const ch of raw) {
    if (depth > 0) cur += ch
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{') {
      depth++
      if (depth === 1) cur = ch
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        const obj = tryParseJsonObject(cur)
        if (obj) objs.push(obj)
        cur = ''
      }
    }
  }
  return objs.length >= byLine.length ? objs : byLine
}

function normalizeSuggestion(b: any): BookSuggestion | null {
  const title = cleanText(b?.title, 300)
  const titleEn = cleanText(b?.titleEn || b?.englishTitle || b?.originalTitle, 300)
  if (!title && !titleEn) return null
  const searchTitle = titleEn || title
  const rawLink = cleanText(b?.link || b?.url, 600)
  const link = /^https?:\/\//i.test(rawLink) ? rawLink : googleBooksSearch(searchTitle)
  return {
    title: title || titleEn,
    titleEn,
    author: cleanText(b?.author, 200) || 'مرجع أكاديمي متخصص',
    year: cleanText(b?.year, 20) || 'حديث/متداول',
    reason: cleanText(b?.reason, 600) || 'مرجع مناسب لبناء خلفية معرفية ومنهجية في التخصص.',
    link,
  }
}

function fallbackBookSuggestions(program: { titleAr: string; titleEn?: string | null; category: string; description?: string | null }): BookSuggestion[] {
  const domain = detectProgramDomain(program)
  const spec = specialtyName(program)
  const topic = cleanText(spec.en || spec.ar || program.titleAr, 180)
  const level = LEVEL_AR[program.category] || 'الدراسات المهنية'
  const base = (DOMAIN_BOOKS[domain] && DOMAIN_BOOKS[domain]!.length ? DOMAIN_BOOKS[domain]! : DOMAIN_BOOKS.general)

  return base.map(([titleEn, author, year, reason]) => ({
    title: `${level} في ${spec.ar}: ${titleEn}`.slice(0, 300),
    titleEn,
    author,
    year,
    reason: `${reason} اختير لأنه مرتبط مباشرة بتخصص ${spec.ar} ومستوى ${level}، وليس اقتراحاً عاماً لكل التخصصات.`,
    link: googleBooksSearch(`${titleEn} ${topic}`),
  }))
}

/** اقتراح كتب مرجعية لتخصص البرنامج بناءً على واقع التخصص عالمياً */
export async function suggestBooksForProgram(program: {
  titleAr: string
  titleEn?: string | null
  category: string
  description?: string | null
}): Promise<BookSuggestion[]> {
  const level = LEVEL_AR[program.category] || program.category
  const description = cleanText(program.description, 600)
  const spec = specialtyName(program)
  const domain = detectProgramDomain(program)
  const fallback = fallbackBookSuggestions(program)
  const domainSeedTitles = (DOMAIN_BOOKS[domain] || DOMAIN_BOOKS.general).map(([title]) => title).join(' | ')
  const prompt = `أنت خبير ذكاء اصطناعي أكاديمي متخصص في تحليل مناهج الدراسات العليا وواقع التخصصات في العالم.

التخصص المحدد الحقيقي: "${spec.ar}" (${spec.en || program.titleEn || '-'})
الدرجة فقط: ${level}
اسم البرنامج الكامل في النظام: "${program.titleAr}" (${program.titleEn || '-'}) — درجة: ${level}
وصف البرنامج: ${description || 'لا يوجد وصف تفصيلي؛ استنتج من اسم البرنامج ومستواه.'}
الأكاديمية: ${ACADEMY_INFO.nameAr} — برامج دراسات عليا مهنية دولية.

المطلوب:
- حلل واقع تخصص "${spec.ar}" عالمياً اليوم، وليس الدرجة العامة ولا عبارة «كافة التخصصات».
- اقترح 8 كتب أو مراجع علمية يجب على طالب ${level} في تخصص ${spec.ar} قراءتها ليمتحن بها.
- ممنوع اقتراح كتب قيادة/إدارة/موارد بشرية/تعلم مؤسسي عامة إلا إذا كان التخصص نفسه إدارة أو قيادة.
- إذا كان التخصص الأمن السيبراني مثلاً، يجب أن تكون كل الكتب عن الأمن السيبراني، أمن المعلومات، أمن الشبكات، التشفير، الاستجابة للحوادث، أمن تطبيقات الويب، والتحليل الجنائي الرقمي.
- أمثلة كتب مرجعية مقبولة لهذا المجال إن كان مناسباً: ${domainSeedTitles}
- نوّع بين الكلاسيكيات المرجعية والإصدارات الحديثة، وبين المتوفر بالعربية والإنجليزية قدر الإمكان.
- اذكر لكل كتاب: العنوان بالعربية، العنوان الأصلي بالإنجليزية، المؤلف، سنة النشر التقريبية، وسبب اختياره لهذا التخصص في سطرين كحد أقصى.
- لكل كتاب أضف رابطاً واقعياً آمناً. إذا لم تكن متأكداً من رابط مباشر دقيق، استخدم رابط بحث Google Books أو Open Library ولا تخترع رابطاً مكسوراً.

أجب بصيغة JSON فقط بدون أي نص إضافي — مصفوفة من 8 عناصر:
[{"title":"<العنوان بالعربية>","titleEn":"<العنوان بالإنجليزية>","author":"<المؤلف>","year":"<سنة>","reason":"<سبب الاختيار>","link":"<رابط الكتاب أو رابط بحث عنه>"}]`

  try {
    const raw = await completeJsonWithFallback({
      label: 'book suggestions',
      system: 'أنت خبير أكاديمي يرجع JSON صالحاً فقط دون أي نص إضافي.',
      prompt,
      temperature: 0.25,
      maxOutputTokens: 4096,
      retries: 3,
    })
    const cleaned = extractJsonArray(raw)
      .map(normalizeSuggestion)
      .filter(Boolean) as BookSuggestion[]

    const relevant = cleaned.filter((b) => isSuggestionRelevantToDomain(b, domain))
    const merged = [...relevant]
    for (const b of fallback) {
      if (merged.length >= 8) break
      if (!merged.some((x) => cleanText(x.titleEn || x.title).toLowerCase() === cleanText(b.titleEn || b.title).toLowerCase())) merged.push(b)
    }
    if (merged.length > 0) return merged.slice(0, 8)
  } catch (e: any) {
    console.error('suggestBooksForProgram fallback used:', String(e?.message || e).slice(0, 500))
  }

  return fallback.slice(0, 8)
}

export interface ExamSourceBook {
  title: string
  titleEn?: string | null
  author?: string | null
  year?: string | null
  description?: string | null
  link?: string | null
  textContent?: string | null
  sourceNote?: string | null
  contentQuality?: string | null
}

const BATCH_SPECS: {
  kind: string
  count: number
  instruction: string
}[] = [
  {
    kind: 'MCQ',
    count: 20,
    instruction:
      'أسئلة اختيار من متعدد (4 خيارات أ-د) تغطي المفاهيم والنظريات والمناهج الأساسية في الكتب المقررة كلها، لكل سؤال إجابة صحيحة واحدة. النقاط: 2 لكل سؤال.',
  },
  {
    kind: 'MIX_TF_MCQ',
    count: 20,
    instruction:
      '15 سؤال صح/خطأ (type: TF، options: ["صح","خطأ"]، correct: "0" للصح و"1" للخطأ، النقاط 2) + 5 أسئلة اختيار من متعدد تطبيقية (type: MCQ، النقاط 2) تقيس الفهم العميق لا الحفظ.',
  },
  {
    kind: 'SHORT_A',
    count: 8,
    instruction:
      'أسئلة إجابة قصيرة تحليلية (type: SHORT، النقاط 5) تطلب شرح مفهوم أو مقارنة أو ذكر خطوات — لكل سؤال إجابة نموذجية وافية (modelAnswer) من 2-4 جمل يصحح عليها الذكاء الاصطناعي.',
  },
  {
    kind: 'SHORT_B',
    count: 7,
    instruction:
      'أسئلة إجابة قصيرة تحليلية إضافية (type: SHORT، النقاط 5) تغطي جوانب الكتب التي لم تغطيها الأسئلة السابقة: أهداف المبادئ، الفروق الدقيقة، شروط التطبيق — لكل سؤال إجابة نموذجية (modelAnswer) من 2-4 جمل.',
  },
  {
    kind: 'ESSAY_A',
    count: 5,
    instruction:
      'أسئلة مقالية معمقة (type: ESSAY، النقاط 10) على مستوى بحثي: تحليل نقدي وربط النظريات بواقع التخصص — لكل سؤال إجابة نموذجية مفصلة (modelAnswer) كمعيار تصحيح في 4-6 جمل.',
  },
  {
    kind: 'ESSAY_B',
    count: 5,
    instruction:
      'أسئلة مقالية معمقة إضافية (type: ESSAY، النقاط 10): تصميم حلول لقضايا التخصص، تقييم منهجيات، صياغة رؤى استشرافية — لكل سؤال إجابة نموذجية مفصلة (modelAnswer) في 4-6 جمل.',
  },
  {
    kind: 'CASE_MCQ',
    count: 15,
    instruction:
      'أسئلة اختيار من متعدد مبنية على حالات عملية ودراسات واقعية من مجال التخصص (type: MCQ، 4 خيارات، النقاط 2): تُعرض حالة قصيرة ثم سؤال عن أفضل قرار/تشخيص/منهجية وفقاً لما ورد في الكتب المقررة.',
  },
]

function uniqueStrings(values: string[], max = 30): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values.map((x) => cleanText(x, 180)).filter(Boolean)) {
    const key = norm(v)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(v)
    if (out.length >= max) break
  }
  return out
}

const DOMAIN_CONCEPTS: Partial<Record<ProgramDomain, string[]>> = {
  cybersecurity: [
    'حوكمة أمن المعلومات',
    'إدارة المخاطر السيبرانية',
    'أمن الشبكات والبروتوكولات',
    'التشفير وحماية البيانات',
    'أمن تطبيقات الويب',
    'الاستجابة للحوادث السيبرانية',
    'التحليل الجنائي الرقمي',
    'مراقبة الأحداث الأمنية واكتشاف التهديدات',
    'تحليل البرمجيات الخبيثة',
    'إدارة الهوية والصلاحيات',
  ],
  'artificial-intelligence': ['تعلم الآلة', 'التعلم العميق', 'هندسة البيانات', 'حوكمة الذكاء الاصطناعي', 'تشغيل النماذج في الإنتاج', 'أخلاقيات الذكاء الاصطناعي'],
  'business-analytics': ['نمذجة البيانات', 'التحليل الإحصائي', 'ذكاء الأعمال', 'تصوير البيانات', 'لوحات المؤشرات', 'دعم القرار'],
  'project-management': ['نطاق المشروع', 'إدارة الزمن والتكلفة', 'المخاطر', 'أصحاب المصلحة', 'Agile وScrum', 'إغلاق المشروع'],
  'human-resources': ['تخطيط الموارد البشرية', 'الاستقطاب والاختيار', 'إدارة الأداء', 'التدريب والتطوير', 'التعويضات', 'تحليلات الموارد البشرية'],
  'quality-management': ['التحسين المستمر', 'TQM', 'Six Sigma', 'ISO 9001', 'خرائط العمليات', 'مؤشرات الجودة'],
}

function fallbackExamConcepts(
  program: { titleAr: string; titleEn?: string | null; category: string; description?: string | null },
  books: ExamSourceBook[]
): string[] {
  const domain = detectProgramDomain(program)
  const spec = specialtyName(program)
  const bookTitles = books.flatMap((b) => [b.title, b.titleEn || '', b.description || ''])
  const seedTitles = ((DOMAIN_BOOKS[domain] && DOMAIN_BOOKS[domain]!.length ? DOMAIN_BOOKS[domain]! : DOMAIN_BOOKS.general) || []).map(([t]) => t)
  return uniqueStrings([
    ...(DOMAIN_CONCEPTS[domain] || []),
    ...bookTitles,
    ...seedTitles,
    `مفاهيم ${spec.ar}`,
    `تطبيقات ${spec.ar}`,
    `أخلاقيات ومخاطر ${spec.ar}`,
  ], 40)
}

function makeFallbackMcq(concept: string, specAr: string, caseBased = false, i = 0): GeneratedQuestion {
  const intro = caseBased
    ? `في حالة عملية داخل مؤسسة تريد تحسين ${specAr}، أي إجراء يعكس فهماً صحيحاً لمفهوم ${concept}؟`
    : `أي العبارات الآتية أدق في تفسير مفهوم ${concept} ضمن تخصص ${specAr}؟`
  return {
    type: 'MCQ',
    text: intro,
    options: [
      `تحليل المتطلبات والمخاطر ثم اختيار ضوابط قابلة للقياس وفق سياق المؤسسة`,
      'تطبيق أداة تقنية واحدة دون تحليل البيئة أو أصحاب المصلحة',
      'الاعتماد على الانطباع الشخصي بدلاً من الأدلة والمؤشرات',
      'تأجيل التقييم إلى نهاية البرنامج أو المشروع فقط',
    ],
    correct: '0',
    points: 2,
  }
}

function makeFallbackTf(concept: string, specAr: string, i: number): GeneratedQuestion {
  const truthy = i % 2 === 0
  return {
    type: 'TF',
    text: truthy
      ? `في تخصص ${specAr}، لا تكفي المعرفة النظرية بمفهوم ${concept} ما لم ترتبط بتطبيق عملي ومؤشرات تحقق.`
      : `في تخصص ${specAr}، يمكن اعتماد قرار مهني متعلق بـ ${concept} دون تحليل مخاطر أو أدلة أو سياق المؤسسة.`,
    options: ['صح', 'خطأ'],
    correct: truthy ? '0' : '1',
    points: 2,
  }
}

function makeFallbackShort(concept: string, specAr: string, i: number): GeneratedQuestion {
  return {
    type: 'SHORT',
    text: `اشرح بإيجاز كيف يمكن توظيف مفهوم ${concept} في معالجة مشكلة مهنية ضمن تخصص ${specAr}.`,
    modelAnswer: `الإجابة الجيدة تربط ${concept} بالمشكلة المهنية، وتحدد خطوات تشخيص الوضع، ثم تقترح إجراءً عملياً قابلاً للقياس. يجب أن تتضمن الإجابة مؤشرات متابعة أو معايير نجاح، وأن تبيّن أثر القرار على المؤسسة أو المستفيدين.`,
    points: 5,
  }
}

function makeFallbackEssay(concept: string, specAr: string, i: number): GeneratedQuestion {
  return {
    type: 'ESSAY',
    text: `حلل نقدياً دور ${concept} في تطوير الأداء المهني في مجال ${specAr}، مع اقتراح إطار تطبيقي مناسب.`,
    modelAnswer: `تتناول الإجابة النموذجية تعريف ${concept} وعلاقته بمجال ${specAr}، ثم تحلل نقاط القوة والقيود والمخاطر العملية. يجب أن تقترح إطاراً تطبيقياً يتضمن تشخيصاً أولياً، إجراءات تنفيذ، مؤشرات قياس، ومسؤوليات واضحة. كما ينبغي ربط التحليل بمحتوى الكتب المقررة أو مصادر البرنامج وعدم الاكتفاء بالتعميم.`,
    points: 10,
  }
}

function fallbackExamQuestionBatch(
  program: { titleAr: string; titleEn?: string | null; category: string; description?: string | null },
  books: ExamSourceBook[],
  batchIndex: number
): GeneratedQuestion[] {
  const spec = BATCH_SPECS[batchIndex % BATCH_SPECS.length]
  const specAr = specialtyName(program).ar
  const concepts = fallbackExamConcepts(program, books)
  const pick = (i: number) => concepts[i % Math.max(concepts.length, 1)] || specAr
  const out: GeneratedQuestion[] = []

  if (spec.kind === 'MIX_TF_MCQ') {
    for (let i = 0; i < 15; i++) out.push(makeFallbackTf(pick(i), specAr, i))
    for (let i = 15; i < spec.count; i++) out.push(makeFallbackMcq(pick(i), specAr, false, i))
    return out.slice(0, spec.count)
  }

  for (let i = 0; i < spec.count; i++) {
    if (spec.kind === 'MCQ') out.push(makeFallbackMcq(pick(i), specAr, false, i))
    else if (spec.kind === 'CASE_MCQ') out.push(makeFallbackMcq(pick(i), specAr, true, i))
    else if (spec.kind.startsWith('SHORT')) out.push(makeFallbackShort(pick(i), specAr, i))
    else if (spec.kind.startsWith('ESSAY')) out.push(makeFallbackEssay(pick(i), specAr, i))
  }
  return out.slice(0, spec.count)
}

/** توليد دفعة أسئلة من الكتب المقررة وفق مواصفة الدفعة */
export async function generateExamQuestionBatch(
  program: { titleAr: string; titleEn?: string | null; category: string; description?: string | null },
  books: ExamSourceBook[],
  batchIndex: number
): Promise<GeneratedQuestion[]> {
  const spec = BATCH_SPECS[batchIndex % BATCH_SPECS.length]
  const level = LEVEL_AR[program.category] || 'الدراسات العليا'

  const booksSection = books
    .map((b, i) => {
      const excerpt = (b.textContent || '').slice(0, 3200)
      const meta = [
        b.titleEn ? `العنوان الأصلي: ${b.titleEn}` : '',
        b.author ? `المؤلف: ${b.author}` : '',
        b.year ? `السنة: ${b.year}` : '',
        b.link ? `الرابط/المصدر: ${b.link}` : '',
        b.sourceNote ? `مصدر المحتوى: ${b.sourceNote}` : '',
      ].filter(Boolean).join(' — ')
      return `كتاب ${i + 1}: «${b.title}»${meta ? ` — ${meta}` : ''}
${b.description ? `نبذة: ${b.description.slice(0, 500)}\n` : ''}${excerpt ? `محتوى/فهرس معرفي مقروء أو مستخلص من الكتاب:\n${excerpt}\n` : ''}`
    })
    .join('\n\n')

  const prompt = `أنت خبير ذكاء اصطناعي يمتحن طلاب ${level} في تخصص "${program.titleAr}" (${program.titleEn || '-'}) في ${ACADEMY_INFO.nameAr}.
حللت مصادر الكتب المقررة التالية: نصوص مستخرجة من الملفات عند توفرها، أو محتوى مقروء من الروابط، أو فهارس معرفية مستخلصة من Gemini/المصدر. ابنِ الأسئلة من هذه المواد ومن المعرفة الأكاديمية الموثوقة عن نفس الكتب والتخصص، ولا تفشل بسبب نقص نص حرفي كامل:

${booksSection}

وصف البرنامج: ${cleanText(program.description, 500) || 'غير مذكور'}

الدفعة المطلوبة (${spec.count} سؤالاً):
${spec.instruction}

شروط صارمة:
- مستوى الأسئلة: ${level} — تحليلي وتطبيقي وليس حفظاً سطحياً
- الأسئلة مستمدة من مفاهيم الكتب المقررة أعلاه وحقيقة مجال التخصص عالمياً
- صياغة عربية فصحى واضحة ودقيقة علمياً
- لا تكرر سؤالاً أو فكرة سؤال مرتين
- كل سؤال MCQ له options مصفوفة 4 نصوص و correct رقم الخيار الصحيح كنص "0"-"3"
- كل سؤال TF له options ["صح","خطأ"] و correct "0" أو "1"
- كل سؤال SHORT/ESSAY له modelAnswer (الإجابة النموذجية للتصحيح الآلي)
- points رقماً كما هو محدد في المواصفة
- مهم جداً: أرسل كل سؤال في سطر مستقل — كائن JSON واحد لكل سطر داخل مصفوفة، ولا تستخدم علامة تنصيص " داخل نص السؤال أو الخيارات أو الإجابة النموذجية (استخدم «» بدلاً منها)

أجب بصيغة JSON فقط — مصفوفة من ${spec.count} أسئلة:
[{"type":"MCQ","text":"...","options":["أ","ب","ج","د"],"correct":"0","points":2}]`

  let raw = ''
  try {
    raw = await completeJsonWithFallback({
      label: `exam question batch ${batchIndex + 1}`,
      system: 'أنت أستاذ امتحانات دراسات عليا يرجع JSON صالحاً فقط دون أي نص إضافي أو تعليقات.',
      prompt,
      temperature: 0.25,
      maxOutputTokens: 8192,
      retries: 3,
    })
  } catch (e: any) {
    console.error('generateExamQuestionBatch failed; using deterministic fallback:', String(e?.message || e).slice(0, 600))
    return fallbackExamQuestionBatch(program, books, batchIndex)
  }

  let arr: any[] = []
  try {
    arr = extractJsonArray(raw)
  } catch {
    arr = parseLoose(raw)
  }

  const cleaned: GeneratedQuestion[] = []
  for (const q of arr) {
    const type = String(q.type || '').toUpperCase()
    const text = String(q.text || '').trim()
    if (!text) continue
    if (type === 'MCQ' || type === 'TF') {
      const options = Array.isArray(q.options) ? q.options.map((o: any) => String(o)).slice(0, 6) : null
      const correct = String(q.correct ?? '')
      if (!options || options.length < 2 || correct === '' || Number.isNaN(Number(correct))) continue
      cleaned.push({ type, text: text.slice(0, 2000), options, correct, points: Number(q.points) || 2 })
    } else if (type === 'SHORT' || type === 'ESSAY') {
      const modelAnswer = String(q.modelAnswer || q.correct || '').trim()
      if (!modelAnswer) continue
      cleaned.push({
        type,
        text: text.slice(0, 2000),
        modelAnswer: modelAnswer.slice(0, 3000),
        points: Number(q.points) || (type === 'ESSAY' ? 10 : 5),
      })
    }
  }
  if (cleaned.length < spec.count) {
    const fallback = fallbackExamQuestionBatch(program, books, batchIndex)
    const existing = new Set(cleaned.map((q) => norm(q.text)))
    for (const q of fallback) {
      if (cleaned.length >= spec.count) break
      const key = norm(q.text)
      if (existing.has(key)) continue
      existing.add(key)
      cleaned.push(q)
    }
  }

  return cleaned.length > 0 ? cleaned.slice(0, spec.count) : fallbackExamQuestionBatch(program, books, batchIndex)
}

export const EXAM_BATCH_COUNT = BATCH_SPECS.length
export const EXAM_BATCH_SPECS = BATCH_SPECS

/** وصف عربي لنوع السؤال */
export const QTYPE_AR: Record<string, string> = {
  MCQ: 'اختيار من متعدد',
  TF: 'صح أو خطأ',
  SHORT: 'إجابة قصيرة',
  ESSAY: 'سؤال مقالي',
}
